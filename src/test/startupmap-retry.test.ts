// Pins the startupmap.one fetch resilience in scripts/sources/vc-startupmap.mjs.
// Measured 2026-09-07: startupmap failed in 10 of the last 40 scrape runs, 6 as
// "fetch failed" through the residential proxy and 4 as the 20 s timeout on the
// ~6k-job payload, and a failed day contributes zero rows while the run stays
// green. Each catalogue GET (/api/startups, /api/jobs) now gets a 90 s timeout
// and up to 3 attempts with a 2 s then 8 s backoff; a 4xx is a block, not a
// hiccup, and is never retried. fetchImpl and sleep are injected, so the suite
// touches no network and no real clock.
//
// The suite runs under vitest's jsdom environment (src/test/setup.ts needs
// window) and jsdom's AbortSignal has no static timeout(). The source calls
// AbortSignal.timeout(STARTUPMAP_TIMEOUT_MS) once per attempt, so this file
// installs a recording stub that hands back a real signal. The stub is also
// what pins the 90 s value: the signal itself never exposes its deadline.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchStartupmap,
  sources,
  STARTUPMAP_ATTEMPTS,
  STARTUPMAP_BACKOFF_MS,
  STARTUPMAP_TIMEOUT_MS,
} from "../../scripts/sources/vc-startupmap.mjs";

type Endpoint = "startups" | "jobs";
type Step = () => Promise<Response>;

const STARTUPS = [{ startup_id: 1, name: "Acme", office_city: "Berlin", country: "Germany" }];
const JOBS = {
  jobs: [
    {
      jobs_id: 42,
      startup_id: 1,
      job_title: "Product Manager",
      apply_url: "https://jobs.example.com/acme/pm",
      posted_at: "2026-09-01T08:00:00Z",
    },
  ],
};

const ok = (body: unknown): Step => async () => new Response(JSON.stringify(body), { status: 200 });
const http = (status: number): Step => async () => new Response("", { status });
const netFail = (message: string): Step => async () => {
  throw new TypeError(message);
};

/** A fetch whose per-endpoint script is consumed one step per call; the last
 *  step repeats, so a "fails forever" endpoint is one step long. */
function scriptedFetch(script: Record<Endpoint, Step[]>) {
  const calls: Record<Endpoint, number> = { startups: 0, jobs: 0 };
  const signals: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string, opts?: { signal?: AbortSignal }) => {
    const name: Endpoint | null = url.endsWith("/api/startups")
      ? "startups"
      : url.endsWith("/api/jobs")
        ? "jobs"
        : null;
    if (!name) throw new Error(`unexpected url ${url}`);
    calls[name] += 1;
    signals.push(opts?.signal);
    const steps = script[name];
    const step = steps.length > 1 ? steps.shift()! : steps[0];
    return step();
  });
  return { fetchImpl, calls, signals };
}

const timeoutStub = vi.fn((_ms: number) => new AbortController().signal);
const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  Object.defineProperty(AbortSignal, "timeout", { value: timeoutStub, configurable: true, writable: true });
});
afterAll(() => {
  if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
  else delete (AbortSignal as unknown as Record<string, unknown>).timeout;
});
beforeEach(() => {
  timeoutStub.mockClear();
  sleep = vi.fn(async (_ms: number) => {});
  warn = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const warnLines = () => warn.mock.calls.map((c) => String(c[0]));

describe("retry budget", () => {
  it("returns rows after fail, fail, succeed and makes exactly 3 calls to that endpoint", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [netFail("fetch failed"), netFail("The operation was aborted due to timeout"), ok(JOBS)],
    });
    const rows = await fetchStartupmap({ fetchImpl, sleep });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: "Acme",
      title: "Product Manager",
      url: "https://jobs.example.com/acme/pm",
      location: "Berlin, Germany",
      source: "startupmap",
      posted_at: "2026-09-01",
    });
    expect(calls).toEqual({ startups: 1, jobs: 3 });
  });

  it("backs off 2 s then 8 s between attempts and never sleeps after the last one", async () => {
    const { fetchImpl } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [netFail("fetch failed"), netFail("fetch failed"), ok(JOBS)],
    });
    await fetchStartupmap({ fetchImpl, sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2_000, 8_000]);
    expect(STARTUPMAP_BACKOFF_MS).toEqual([2_000, 8_000]);
    expect(STARTUPMAP_ATTEMPTS).toBe(3);
  });

  it("logs one WARN line per failed attempt naming the endpoint, the attempt and the error", async () => {
    const { fetchImpl } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [netFail("fetch failed"), netFail("The operation was aborted due to timeout"), ok(JOBS)],
    });
    await fetchStartupmap({ fetchImpl, sleep });
    const lines = warnLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("WARN");
    expect(lines[0]).toContain("/api/jobs");
    expect(lines[0]).toContain("attempt 1/3");
    expect(lines[0]).toContain("fetch failed");
    expect(lines[1]).toContain("attempt 2/3");
    expect(lines[1]).toContain("The operation was aborted due to timeout");
  });

  it("throws the fetch error after 3 failed attempts and stops at exactly 3 calls", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [netFail("fetch failed")],
    });
    await expect(fetchStartupmap({ fetchImpl, sleep })).rejects.toThrow("fetch failed");
    expect(calls.jobs).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(warnLines()).toHaveLength(3);
  });

  it("retries a 5xx as a hiccup and then throws the HTTP shape scrape.mjs logs", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [http(503)],
    });
    await expect(fetchStartupmap({ fetchImpl, sleep })).rejects.toThrow("jobs HTTP 503");
    expect(calls.jobs).toBe(3);
  });
});

describe("4xx is a block, not a hiccup", () => {
  it("throws after one call on a 403 and never sleeps", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [http(403)],
    });
    await expect(fetchStartupmap({ fetchImpl, sleep })).rejects.toThrow("jobs HTTP 403");
    expect(calls.jobs).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(warnLines()).toHaveLength(0);
  });

  it("keeps the startups error shape too", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [http(404)],
      jobs: [ok(JOBS)],
    });
    await expect(fetchStartupmap({ fetchImpl, sleep })).rejects.toThrow("startups HTTP 404");
    expect(calls.startups).toBe(1);
  });
});

describe("the two endpoints have separate budgets", () => {
  it("a failing startups call does not spend the jobs call's budget", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [netFail("fetch failed")],
      jobs: [netFail("fetch failed")],
    });
    await expect(fetchStartupmap({ fetchImpl, sleep })).rejects.toThrow("fetch failed");
    // Promise.all rejects on the first loser; let the other loop run out on its own.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual({ startups: 3, jobs: 3 });
  });

  it("a failing startups call leaves a jobs call that succeeded at one call", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      startups: [netFail("fetch failed")],
      jobs: [ok(JOBS)],
    });
    await expect(fetchStartupmap({ fetchImpl, sleep })).rejects.toThrow("fetch failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual({ startups: 3, jobs: 1 });
  });
});

describe("timeout", () => {
  it("asks for a fresh 90 s AbortSignal on every attempt and passes it to fetch", async () => {
    const { fetchImpl, signals } = scriptedFetch({
      startups: [ok(STARTUPS)],
      jobs: [netFail("fetch failed"), ok(JOBS)],
    });
    await fetchStartupmap({ fetchImpl, sleep });
    expect(STARTUPMAP_TIMEOUT_MS).toBe(90_000);
    expect(timeoutStub).toHaveBeenCalledTimes(3);
    for (const call of timeoutStub.mock.calls) expect(call[0]).toBe(90_000);
    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
    expect(new Set(signals).size).toBe(3);
  });
});

describe("wiring", () => {
  it("the startupmap.one descriptor still runs fetchStartupmap with the real defaults", () => {
    const descriptor = sources.find((s) => s.company === "startupmap.one");
    expect(descriptor?.run).toBe(fetchStartupmap);
  });
});

// The WIRING of api/scrape-dispatch.ts: pg_cron's daily start of the scrape.
//
// The endpoint is small, and every line of it is a way to lose a morning
// without a word. Five mutations were written against it, each one a scrape
// that silently does not happen or a stranger who can make it happen, and the
// five cases below kill exactly those five. Each was watched fail against its
// own mutant before it was kept:
//
//   1. the cronAuthResult guard deleted, leaving the endpoint public.
//   2. the dispatch body sent with the WATCHDOG's reason (or a wrong ref), so the
//      daily start spends the watchdog's once-a-day restart budget, or starts
//      the wrong branch.
//   3. a refused dispatch answered 200, so pg_cron's ledger reads success while
//      no run was started.
//   4. the SCRAPE_DISPATCH_TOKEN guard deleted, so GitHub is called with an
//      empty bearer and the endpoint reports GitHub's refusal instead of its own
//      missing configuration.
//   5. (review round 1, 2026-09-07) the catch block of dispatchWorkflow returning
//      true, so a fetch that never reached GitHub ("fetch failed", the most
//      common egress failure in the scrape logs) answers 200 {dispatched: true}.
//      Cases 1 to 4 only ever RESOLVE the injected fetch; this mutant survived
//      all of them.
//
// Same seam as src/test/scrape-watchdog-wiring.test.ts: injected dependencies
// with real defaults.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handler, SCHEDULED_DISPATCH_REASON } from "../../api/scrape-dispatch";
import { WATCHDOG_DISPATCH_REASON } from "@/lib/scrapeWatchdog";

type Call = { url: string; method: string; body?: string; headers?: Record<string, string> };

/** Records every outbound call and answers the dispatch endpoint with `dispatchStatus`. */
function recordingFetch(calls: Call[], dispatchStatus = 204): typeof fetch {
  const reply = (status: number, body: unknown) =>
    ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: init?.headers as Record<string, string> | undefined,
    });
    if (url.endsWith("/dispatches")) return reply(dispatchStatus, { message: dispatchStatus === 204 ? "" : "refused in test" });
    return reply(404, { message: "unrouted in test" });
  }) as unknown as typeof fetch;
}

function fakeRes() {
  const seen: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      seen.status = code;
      return res;
    },
    json(body: unknown) {
      seen.body = body as Record<string, unknown>;
    },
  };
  return { res, seen };
}

const CRON_SECRET = "test-cron-secret";
const authed = { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } };

describe("api/scrape-dispatch wiring", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    delete process.env.CRON_SECRET_DB;
    process.env.SCRAPE_DISPATCH_TOKEN = "test-github-token";
    process.env.SCRAPE_DISPATCH_REPO = "acme/northgoing";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("refuses an unauthenticated request and makes no GitHub call (mutant: delete the cronAuthResult guard)", async () => {
    const calls: Call[] = [];
    const { res, seen } = fakeRes();

    await handler({ method: "POST", headers: {} }, res, { fetchImpl: recordingFetch(calls) });

    expect(seen.status).toBe(401);
    expect(seen.body).toEqual({ error: "Unauthorized" });
    // Refused BEFORE any work: a stranger cannot start the runner on our token.
    expect(calls).toEqual([]);
  });

  it("asks GitHub for scrape.yml on main with reason=scheduled (mutant: send the watchdog's reason, or another ref)", async () => {
    const calls: Call[] = [];
    const { res, seen } = fakeRes();

    await handler(authed, res, { fetchImpl: recordingFetch(calls) });

    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ ok: true, dispatched: true, reason: SCHEDULED_DISPATCH_REASON });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.github.com/repos/acme/northgoing/actions/workflows/scrape.yml/dispatches");
    expect(call.headers?.Authorization).toBe("Bearer test-github-token");
    expect(JSON.parse(call.body ?? "{}")).toEqual({ ref: "main", inputs: { reason: "scheduled" } });
    // The daily start must never read as a watchdog restart in the run list, or
    // it spends the watchdog's once-a-day budget every morning.
    expect(SCHEDULED_DISPATCH_REASON).not.toBe(WATCHDOG_DISPATCH_REASON);
  });

  it("answers non-2xx and does not throw when GitHub refuses the dispatch (mutant: answer 200 regardless)", async () => {
    const calls: Call[] = [];
    const { res, seen } = fakeRes();

    await expect(handler(authed, res, { fetchImpl: recordingFetch(calls, 422) })).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(seen.status).toBe(502);
    expect(seen.body).toMatchObject({ ok: false, dispatched: false });
  });

  it("answers 502 and does not throw when the fetch itself throws (mutant: the catch block returns true)", async () => {
    // The request never reached GitHub: a proxy drop, a DNS miss, an aborted
    // socket. Node's fetch surfaces every one of them as a thrown TypeError
    // whose message is "fetch failed", and the scrape logs show it is the most
    // common way an outbound call dies. Nothing was started, so the endpoint
    // must say so. The case above only covers a fetch that RESOLVED with a bad
    // status; a fetch that REJECTS takes a different branch, and a mutant that
    // made that branch report success survived every other case in this file.
    const attempts: Call[] = [];
    const thrown = new TypeError("fetch failed");
    const rejectingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      attempts.push({ url: String(input), method: init?.method ?? "GET" });
      throw thrown;
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, seen } = fakeRes();

    try {
      await expect(handler(authed, res, { fetchImpl: rejectingFetch })).resolves.toBeUndefined();

      // GitHub WAS asked, once. This is what separates a dead network from the
      // missing-token case below, which must not ask at all.
      expect(attempts).toHaveLength(1);
      expect(attempts[0].url).toBe("https://api.github.com/repos/acme/northgoing/actions/workflows/scrape.yml/dispatches");
      expect(seen.status).toBe(502);
      expect(seen.body).toMatchObject({ ok: false, dispatched: false, reason: SCHEDULED_DISPATCH_REASON });
      // And it was said out loud, with the cause, on the catch path: a false
      // that nobody logged would be the next silent failure. (reportApiError is
      // a no-op without a Sentry DSN, so the warn line is the observable side.)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[scrape-dispatch] GitHub dispatch failed:"), thrown);
    } finally {
      warn.mockRestore();
    }
  });

  it("answers 500 and makes no GitHub call when SCRAPE_DISPATCH_TOKEN is missing (mutant: drop the token guard)", async () => {
    process.env.SCRAPE_DISPATCH_TOKEN = "   ";
    const calls: Call[] = [];
    const { res, seen } = fakeRes();

    await handler(authed, res, { fetchImpl: recordingFetch(calls) });

    expect(seen.status).toBe(500);
    expect(seen.body).toEqual({ error: "Missing SCRAPE_DISPATCH_TOKEN" });
    // Its own misconfiguration, reported as such: not GitHub's 401 on an empty bearer.
    expect(calls).toEqual([]);
  });
});

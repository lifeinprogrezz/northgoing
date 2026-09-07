// The WIRING of api/scrape-watchdog.ts, not its arithmetic.
//
// src/lib/scrapeWatchdog.test.ts already pins the pure decisions: unknown alerts,
// stale alerts, the dispatch side fails closed. None of that reached the endpoint
// that reads Storage and calls GitHub, so the fail-safe rule held only where the
// tests looked. An adversarial pass proved it: four mutations of the endpoint,
// every one a silent watchdog, all four survived the full suite.
//
//   1. probeDataplane answering with a fabricated fresh timestamp when the
//      dataplane row is MISSING.
//   2. the same when Storage returns an ERROR.
//   3. dispatchWorkflow firing whether or not the decision said to dispatch.
//   4. the cronAuthResult guard deleted, leaving the endpoint public.
//
// The four cases below kill exactly those four, and each was watched fail against
// its own mutant before it was kept. A guard nobody has seen catch anything is
// not yet a guard. The seam is the repo's usual one: injected dependencies with
// real defaults, the same shape as confirmGmailForwarding in api/inbound-email.ts.
//
// A fifth mutation (review round 1, 2026-09-07): the shared dispatchWorkflow's
// catch block returning true, so a restart whose request never reached GitHub
// emails "restarting the scrape" while no run exists. Every fetch above
// RESOLVES; the last case in the file is the one that REJECTS.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handler, probeDataplane, type StorageClient } from "../../api/scrape-watchdog";
import { decideDataplaneFreshness } from "@/lib/scrapeWatchdog";

const NOW = Date.parse("2026-08-28T08:00:00.000Z");
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type StorageRow = { name: string; updated_at?: string | null };
type ListResult = { data: StorageRow[] | null; error: { message: string } | null };

/** A Storage bucket that answers with whatever the test decided, and counts reads. */
function fakeStorage(result: ListResult) {
  const listed: { bucket: string; search: string }[] = [];
  const client: StorageClient = {
    storage: {
      from: (bucket) => ({
        list: async (_path, options) => {
          listed.push({ bucket, search: options.search });
          return result;
        },
      }),
    },
  };
  return { client, listed };
}

type Call = { url: string; method: string; body?: string };

/**
 * Records every outbound call and answers Resend and GitHub the way they do.
 * `dispatchError`, when given, makes the dispatch call REJECT after it is
 * recorded: the request left, and never got an answer.
 */
function recordingFetch(
  calls: Call[],
  runsBody: unknown = { workflow_runs: [] },
  dispatchError?: Error,
): typeof fetch {
  const reply = (status: number, body: unknown) =>
    ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/runs?")) return reply(200, runsBody);
    if (url.endsWith("/dispatches")) {
      if (dispatchError) throw dispatchError;
      return reply(204, {});
    }
    if (url.startsWith("https://api.resend.com")) return reply(200, { id: "email_test" });
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
const authed = { method: "GET", headers: { authorization: `Bearer ${CRON_SECRET}` } };

describe("probeDataplane: what the endpoint reports when Storage cannot prove the scrape ran", () => {
  it("MISSING row: reports no timestamp, and the verdict ALERTS (mutant: answer with a fresh timestamp instead)", async () => {
    // The bucket exists and the read worked. There is simply no dataplane.json,
    // which is what a pipeline that never reached its last step leaves behind.
    const { client, listed } = fakeStorage({ data: [{ name: "something-else.json", updated_at: iso(HOUR) }], error: null });

    const probe = await probeDataplane(client);

    expect(listed).toEqual([{ bucket: "dataplane", search: "dataplane.json" }]);
    expect(probe.updatedAt).toBeNull();
    // The rule, stated where it is enforced: a missing artifact is never health.
    const verdict = decideDataplaneFreshness(probe, NOW);
    expect(verdict.alert).toBe(true);
    expect(verdict.state).toBe("unknown");
  });

  it("Storage ERROR: reports the problem, and the verdict ALERTS (mutant: answer with a fresh timestamp instead)", async () => {
    const { client } = fakeStorage({ data: null, error: { message: "Bucket not found" } });

    const probe = await probeDataplane(client);

    expect(probe.updatedAt).toBeNull();
    expect(probe.problem).toContain("Bucket not found");
    const verdict = decideDataplaneFreshness(probe, NOW);
    expect(verdict.alert).toBe(true);
    expect(verdict.state).toBe("unknown");
  });

  it("control: a row written this morning is the one thing that reports healthy, so the two cases above are not passing by accident", async () => {
    const { client } = fakeStorage({ data: [{ name: "dataplane.json", updated_at: iso(3 * HOUR) }], error: null });

    const probe = await probeDataplane(client);

    expect(probe.updatedAt).toBe(iso(3 * HOUR));
    expect(probe.problem).toBeNull();
    expect(decideDataplaneFreshness(probe, NOW).alert).toBe(false);
  });
});

describe("the endpoint's wiring", () => {
  // The handler reads the real clock, so these fixtures hang off the real clock
  // too. A fixed NOW would make "30 hours old" mean a fixed instant, and the
  // verdict would then depend on the hour the suite happens to run.
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    delete process.env.CRON_SECRET_DB;
    process.env.SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.OWNER_ALERT_EMAIL = "owner@example.test";
    process.env.SCRAPE_DISPATCH_TOKEN = "test-github-token";
    process.env.SCRAPE_DISPATCH_REPO = "acme/northgoing";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("does not start the workflow when the decision said not to start it (mutant: drop the `if (decision.dispatch)` guard)", async () => {
    // The maximal near-miss: the pool IS stale, a token IS present, the run
    // history IS readable, so every condition for a restart holds except the one
    // that matters. THE WATCHDOG dispatched a run two hours ago -- the run-name
    // marker is what says so -- and it may start one at most once a day, so the
    // decision is no. Without the guard the endpoint would restart the runner on
    // every stale morning, which is the runaway the bound exists to prevent.
    const { client, listed } = fakeStorage({
      data: [{ name: "dataplane.json", updated_at: ago(30 * HOUR) }],
      error: null,
    });
    const calls: Call[] = [];
    const fetchImpl = recordingFetch(calls, {
      workflow_runs: [{ created_at: ago(2 * HOUR), display_title: "Scrape jobs (watchdog restart)" }],
    });
    const { res, seen } = fakeRes();

    await handler(authed, res, { createStorageClient: () => client, fetchImpl });

    // Nothing was posted to the dispatch endpoint. This is the assertion the
    // mutant fails: it turns the read of the run history into a restart.
    expect(calls.filter((c) => c.url.endsWith("/dispatches"))).toEqual([]);
    expect(listed).toHaveLength(1);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({ state: "stale", alert: true, dispatchPlanned: false, dispatched: false });
    // Held back by the once-a-day bound, not by some earlier return.
    expect(String(seen.body?.dispatchReason)).toContain("at most once every 20 hours");
    // The owner still hears about it. The run got far enough to email, which is
    // what makes the absent dispatch a decision rather than an early return.
    expect(calls.some((c) => c.url.startsWith("https://api.resend.com"))).toBe(true);
    expect(seen.body).toMatchObject({ emailed: true });
  });

  it("restarts the workflow when the only recent dispatch was started BY HAND (regression: 2026-08-28)", async () => {
    // What actually happened on 2026-08-28, and the reason this test exists.
    // The pool was 15.6 hours stale. The watchdog emailed correctly and then
    // refused to restart anything, reporting "already started this workflow 20.8
    // hours ago". It had not. Rober had dispatched that run by hand the previous
    // morning. The once-a-day bound is a bound on the WATCHDOG's restarts, and a
    // person's run must not spend it -- otherwise the self-healing layer is
    // disabled by the very act of a human checking on it.
    //
    // The fixture is that morning: a manual run 20.8 hours ago sitting in FRONT
    // of the watchdog's own last restart, which is 30 hours old and so outside
    // the bound. Reading only the newest dispatch is what produced the bug, so
    // the newest dispatch here is the manual one.
    const { client } = fakeStorage({
      data: [{ name: "dataplane.json", updated_at: ago(15.6 * HOUR) }],
      error: null,
    });
    const calls: Call[] = [];
    const fetchImpl = recordingFetch(calls, {
      workflow_runs: [
        { created_at: ago(20.8 * HOUR), display_title: "Scrape jobs" },
        { created_at: ago(30 * HOUR), display_title: "Scrape jobs (watchdog restart)" },
      ],
    });
    const { res, seen } = fakeRes();

    await handler(authed, res, { createStorageClient: () => client, fetchImpl });

    const dispatches = calls.filter((c) => c.url.endsWith("/dispatches"));
    expect(dispatches).toHaveLength(1);
    expect(seen.body).toMatchObject({ state: "stale", alert: true, dispatchPlanned: true, dispatched: true });
    // And the restart marks ITSELF, so tomorrow's run of this same check can find
    // it. Without the input the fix would work once and then forget.
    expect(JSON.parse(dispatches[0].body ?? "{}")).toMatchObject({ inputs: { reason: "watchdog" } });
  });

  it("control: the watchdog's OWN restart inside the window still blocks a second one", async () => {
    // The pair to the case above. Same stale pool, same two runs, except the
    // watchdog's own restart is now the recent one. If this dispatched too, the
    // fix above would have removed the bound rather than corrected it.
    const { client } = fakeStorage({
      data: [{ name: "dataplane.json", updated_at: ago(15.6 * HOUR) }],
      error: null,
    });
    const calls: Call[] = [];
    const fetchImpl = recordingFetch(calls, {
      workflow_runs: [
        { created_at: ago(3 * HOUR), display_title: "Scrape jobs (watchdog restart)" },
        { created_at: ago(20.8 * HOUR), display_title: "Scrape jobs" },
      ],
    });
    const { res, seen } = fakeRes();

    await handler(authed, res, { createStorageClient: () => client, fetchImpl });

    expect(calls.filter((c) => c.url.endsWith("/dispatches"))).toEqual([]);
    expect(seen.body).toMatchObject({ dispatchPlanned: false, emailed: true });
  });

  it("refuses an unauthenticated request and never reads Storage (mutant: delete the cronAuthResult guard)", async () => {
    const { client, listed } = fakeStorage({
      data: [{ name: "dataplane.json", updated_at: ago(3 * HOUR) }],
      error: null,
    });
    const calls: Call[] = [];
    const { res, seen } = fakeRes();

    await handler(
      { method: "GET", headers: {} },
      res,
      { createStorageClient: () => client, fetchImpl: recordingFetch(calls) },
    );

    expect(seen.status).toBe(401);
    expect(seen.body).toEqual({ error: "Unauthorized" });
    // Refused BEFORE any work: a stranger can neither read the bucket nor make
    // the deployment spend a call on their behalf.
    expect(listed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reports the restart as FAILED and emails 'could not restart it' when the dispatch request throws (mutant: dispatchWorkflow's catch returns true)", async () => {
    // The same morning as the 2026-08-28 regression above, so the decision IS to
    // restart. This time the POST to GitHub dies on the wire: Node's fetch
    // rejects with TypeError "fetch failed" (proxy drop, DNS miss, aborted
    // socket). No run was started. The email the owner reads at breakfast has
    // to say "could not restart it", and the response has to carry
    // dispatchFailed, or the morning is lost while the watchdog reports it
    // healed.
    const { client } = fakeStorage({
      data: [{ name: "dataplane.json", updated_at: ago(15.6 * HOUR) }],
      error: null,
    });
    const calls: Call[] = [];
    const fetchImpl = recordingFetch(
      calls,
      {
        workflow_runs: [
          { created_at: ago(20.8 * HOUR), display_title: "Scrape jobs" },
          { created_at: ago(30 * HOUR), display_title: "Scrape jobs (watchdog restart)" },
        ],
      },
      new TypeError("fetch failed"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, seen } = fakeRes();

    try {
      await expect(handler(authed, res, { createStorageClient: () => client, fetchImpl })).resolves.toBeUndefined();

      // The restart WAS attempted: this is a dead wire, not a withheld decision.
      expect(calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(1);
      expect(seen.status).toBe(200);
      expect(seen.body).toMatchObject({ dispatchPlanned: true, dispatched: false, dispatchFailed: true, emailed: true });
      // And the email tells the truth. The subject is the one line the owner
      // sees without opening it.
      const email = calls.find((c) => c.url.startsWith("https://api.resend.com"));
      const payload = JSON.parse(email?.body ?? "{}") as { subject?: string; text?: string };
      expect(payload.subject).toContain("(could not restart it)");
      expect(payload.subject).not.toContain("(restarting the scrape)");
      expect(payload.text).toContain("GitHub refused the request, so nothing was started");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[scrape-watchdog] GitHub dispatch failed:"), expect.any(TypeError));
    } finally {
      warn.mockRestore();
    }
  });
});

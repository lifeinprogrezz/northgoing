// Scrape dispatch (2026-09-07): pg_cron starts the daily scrape.
//
// WHY THIS EXISTS. The scrape workflow (scrape.yml) carried GitHub's own
// `schedule: 47 3 * * *`, and GitHub never honoured it on time. Seven mornings
// out of seven, 9-01 to 9-07, the scheduled run fired between 07:52 and 08:55
// UTC. Every one of those mornings the 05:15 watchdog found the pool about 21
// hours stale, restarted the workflow, and emailed the owner; the 06:00 digest
// was served from that restart; and GitHub's late run then scraped the whole
// pool a second time (extract and enrich spend, a second dataplane publish).
// The 8-28 rule was "third strike and the scrape leaves GitHub cron". It left.
//
// WHAT THIS DOES. pg_cron job `northgoing-scrape-dispatch` runs
// public.tick_worker('scrape-dispatch') at 03:47 UTC (migration
// 20260907190000_scrape_dispatch_pg_cron.sql), which posts here with the cron
// secret from Vault. This endpoint asks GitHub to start scrape.yml on main with
// reason=scheduled. The run is named "Scrape jobs (scheduled)", NOT the
// watchdog's marker, so the watchdog's once-a-day restart budget is never spent
// by the daily start.
//
// THE WATCHDOG STAYS THE GUARD. Nothing here retries or emails. If this call
// never reaches GitHub, or GitHub accepts it and the run fails, the dataplane is
// still stale at 05:15 and api/scrape-watchdog.ts restarts the workflow and
// tells the owner, exactly as it did on the seven mornings above. A missing
// token is a 500, a refused dispatch is a 502, both reported to Sentry; success
// is silent. Pinned by src/test/scrape-dispatch-wiring.test.ts: refused auth
// makes no GitHub call, the body carries ref main + reason scheduled, a refused
// dispatch answers non-2xx without throwing, a missing token answers 500 with no
// call. Rule and code move together. The seam is the deps argument, defaulting
// to the real fetch, the same shape as api/scrape-watchdog.ts.
//
// Env: CRON_SECRET / CRON_SECRET_DB + SCRAPE_DISPATCH_TOKEN (required here,
// optional for the watchdog) + optional SCRAPE_DISPATCH_REPO.
import { cronAuthResult } from "../src/lib/nightly.js";
import { DEFAULT_REPO, dispatchWorkflow } from "../src/lib/githubDispatch.js";
import { reportApiError, setRunSummary, withSentry } from "../src/lib/apiSentry.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { status: (code: number) => Res; json: (body: unknown) => void };

/**
 * The value sent as the workflow's `reason` input. scrape.yml turns it into the
 * run-name "Scrape jobs (scheduled)". It must never equal the watchdog's
 * WATCHDOG_DISPATCH_REASON: that value is what the watchdog counts as its own
 * restart when it proves its once-a-day bound.
 */
export const SCHEDULED_DISPATCH_REASON = "scheduled";

export type DispatchDeps = {
  fetchImpl?: typeof fetch;
};

export async function handler(req: Req, res: Res, deps: DispatchDeps = {}): Promise<void> {
  const authError = cronAuthResult(
    [process.env.CRON_SECRET, process.env.CRON_SECRET_DB],
    req.headers["authorization"],
  );
  if (authError) {
    res.status(authError.status).json({ error: authError.error });
    return;
  }
  const token = (process.env.SCRAPE_DISPATCH_TOKEN ?? "").trim();
  const repo = process.env.SCRAPE_DISPATCH_REPO || DEFAULT_REPO;
  if (!token) {
    // Without a token there is nothing to dispatch with. Say so loudly: a
    // silent 200 here would look like a scheduled scrape that never happens.
    reportApiError("[scrape-dispatch] cannot run: missing SCRAPE_DISPATCH_TOKEN");
    setRunSummary({ dispatched: false, reason: SCHEDULED_DISPATCH_REASON });
    res.status(500).json({ error: "Missing SCRAPE_DISPATCH_TOKEN" });
    return;
  }

  const dispatched = await dispatchWorkflow({
    repo,
    token,
    reason: SCHEDULED_DISPATCH_REASON,
    caller: "scrape-dispatch",
    fetchImpl: deps.fetchImpl,
  });

  const summary = { dispatched, reason: SCHEDULED_DISPATCH_REASON };
  console.log("[scrape-dispatch]", JSON.stringify(summary));
  setRunSummary(summary);

  if (!dispatched) {
    // dispatchWorkflow already reported the status or the thrown cause to Sentry.
    res.status(502).json({ ok: false, ...summary, error: "GitHub refused the workflow dispatch" });
    return;
  }
  res.status(200).json({ ok: true, ...summary });
}

export default withSentry("scrape-dispatch", handler);

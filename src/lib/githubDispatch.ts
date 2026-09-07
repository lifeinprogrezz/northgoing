// GitHub workflow dispatch (2026-09-07): the one call that starts the scrape
// workflow from outside GitHub. Two endpoints make it:
//
//   api/scrape-dispatch.ts   03:47 UTC, from pg_cron. The daily start.
//   api/scrape-watchdog.ts   05:15 UTC, from pg_cron. The restart, only when the
//                            morning's run did not publish a fresh dataplane.
//
// WHY IT MOVED HERE. Until 2026-09-07 the daily start was GitHub's own
// `schedule:` on scrape.yml and this code lived inside the watchdog. Seven
// mornings in a row (9-01 to 9-07) the 03:47 schedule fired between 07:52 and
// 08:55, so the 05:15 watchdog restarted the scrape every day and GitHub's late
// run then scraped a second time. The daily start now comes from the scheduler
// that fires on time, pg_cron, through api/scrape-dispatch.ts. Both callers must
// send the same request shape, so the request lives once, here.
//
// THE `reason` INPUT NAMES THE RUN. scrape.yml sets its run-name from it:
// 'watchdog' marks a watchdog restart, 'scheduled' marks the daily start. The
// watchdog proves its once-a-day restart bound by reading that marker back, so
// a scheduled run must never carry the watchdog's reason or it spends the
// restart budget (src/lib/scrapeWatchdog.ts, WATCHDOG_RUN_MARKER).
//
// Fail-soft: logs, reports to Sentry, returns false. Never throws. The seam is
// the fetchImpl argument, defaulting to the real fetch, the same shape as the
// rest of the api/ endpoints. Pinned by src/test/scrape-dispatch-wiring.test.ts
// and src/test/scrape-watchdog-wiring.test.ts.
import { reportApiError } from "./apiSentry.js";

export const DEFAULT_REPO = "lifeinprogrezz/northgoing";
export const WORKFLOW_FILE = "scrape.yml";
export const WORKFLOW_REF = "main";

/**
 * The headers every GitHub API call from our endpoints carries. `caller` is the
 * endpoint's name and lands in the User-Agent, so a request is attributable in
 * GitHub's logs to the endpoint that made it.
 */
export const githubHeaders = (token: string, caller: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `northgoing-${caller}`,
});

export type DispatchWorkflowInput = {
  /** `owner/name`, from SCRAPE_DISPATCH_REPO or DEFAULT_REPO. */
  repo: string;
  /** A GitHub token with actions write permission, SCRAPE_DISPATCH_TOKEN. */
  token: string;
  /** The workflow's `reason` input; see the note above on what it names. */
  reason: string;
  /** The endpoint asking, for the log prefix, the Sentry line and the User-Agent. */
  caller: string;
  fetchImpl?: typeof fetch;
};

/** Start the scrape workflow. Fail-soft: logs and returns false, never throws. */
export async function dispatchWorkflow(input: DispatchWorkflowInput): Promise<boolean> {
  const { repo, token, reason, caller } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...githubHeaders(token, caller), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: WORKFLOW_REF, inputs: { reason } }),
    });
    if (!res.ok) {
      console.warn(`[${caller}] GitHub dispatch ${res.status}:`, await res.text().catch(() => ""));
      reportApiError(`[${caller}] GitHub dispatch non-ok ${res.status}`, { status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[${caller}] GitHub dispatch failed:`, e);
    reportApiError(`[${caller}] GitHub dispatch threw`, {
      cause: e instanceof Error ? e.name : "unknown",
    });
    return false;
  }
}

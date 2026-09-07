// Scrape watchdog (2026-08-27) — sibling of api/spend-alert.ts.
//
// Layer 1, live now: once a day, check that the daily scrape published a fresh
// dataplane artifact to Supabase Storage. That artifact is written by the LAST
// step of the ten-step scrape pipeline, so a fresh timestamp proves the whole
// chain finished. A stale one, or one that cannot be read at all, emails the
// owner through Resend on the same path the daily spend alert uses.
//
// Layer 2, dormant until a token exists: when SCRAPE_DISPATCH_TOKEN holds a
// GitHub token with actions write permission, the same call also restarts the
// scrape workflow through the GitHub workflow dispatch endpoint, at most once a
// day. With no token it behaves exactly like layer 1 and never errors, the same
// graceful shape as public.tick_worker doing nothing while its Vault secret is
// absent.
//
// The fail-safe direction lives in src/lib/scrapeWatchdog.ts: when the check
// cannot tell, it ALERTS. See the comment there.
//
// That rule is enforced HERE, in the reads and the calls, and it is pinned here
// too: src/test/scrape-watchdog-wiring.test.ts holds the storage read, the
// dispatch guard and the cron guard against the mutations that would each make
// this watchdog silent. Rule and code move together. The seam it uses is the
// deps argument on the handler, plus the fetchImpl argument on the three calls
// that leave the machine, all defaulting to the real thing.
//
// Scheduled by pg_cron at 05:15 UTC, after the scrape's 03:47 UTC start,
// BEFORE the 06:00 nightly scorer, so a restart refills the pool in time for
// the digest (supabase/migrations/20260831160000_scrape_watchdog_0515.sql).
//
// Since 2026-09-07 the 03:47 start is pg_cron's too: api/scrape-dispatch.ts
// asks GitHub for the run, because GitHub's own schedule fired between 07:52
// and 08:55 seven mornings in a row and this watchdog restarted the scrape
// every one of them. The GitHub dispatch call both endpoints make lives in
// src/lib/githubDispatch.ts. This watchdog's behaviour did not change: it is
// the guard for the morning the dispatch never reaches GitHub.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY / CRON_SECRET
// (same contract as api/spend-alert.ts) + optional OWNER_ALERT_EMAIL,
// SCRAPE_DISPATCH_TOKEN, SCRAPE_DISPATCH_REPO.
import { createClient } from "@supabase/supabase-js";
import { cronAuthResult } from "../src/lib/nightly.js";
import { BRAND_NAME } from "../src/lib/brandName.js";
import {
  decideDataplaneFreshness,
  decideDispatch,
  buildWatchdogSubject,
  buildWatchdogBody,
  isWatchdogRestart,
  WATCHDOG_DISPATCH_REASON,
  type DataplaneProbe,
} from "../src/lib/scrapeWatchdog.js";
import { reportApiError, setRunSummary, withSentry } from "../src/lib/apiSentry.js";
import { DEFAULT_REPO, WORKFLOW_FILE, dispatchWorkflow, githubHeaders } from "../src/lib/githubDispatch.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { status: (code: number) => Res; json: (body: unknown) => void };

// Same sender as the nightly digest and the spend alert; all three move together.
const EMAIL_FROM = `${BRAND_NAME} <matches@northgoing.com>`;
const DEFAULT_OWNER_EMAIL = "hello@lifeinprogrezz.com";

const BUCKET = "dataplane";
const ARTIFACT = "dataplane.json";
const GITHUB_CALLER = "scrape-watchdog";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Fire one Resend notification. Fail-soft: logs and returns false, never throws. */
async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject,
        text,
        html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
      }),
    });
    if (!res.ok) {
      console.warn(`[scrape-watchdog] Resend ${res.status}:`, await res.text().catch(() => ""));
      reportApiError(`[scrape-watchdog] Resend non-ok ${res.status}`, { status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    // Sentry, not just console: the Vercel runtime log is not readable on this
    // plan, so a console line here IS silence, and silence is the one outcome a
    // watchdog may never have.
    console.warn("[scrape-watchdog] Resend fetch failed:", e);
    reportApiError("[scrape-watchdog] alert email could not be sent", {
      cause: e instanceof Error ? e.name : "unknown",
    });
    return false;
  }
}

/**
 * The one Storage call this endpoint makes, narrowed to what it reads. Exported
 * so a test can hand probeDataplane a fake bucket instead of a live project:
 * the fail-safe rule below is only worth anything if a test can watch it hold.
 */
export type StorageClient = {
  storage: {
    from: (bucket: string) => {
      list: (
        path: string,
        options: { limit: number; search: string },
      ) => Promise<{ data: { name: string; updated_at?: string | null }[] | null; error: { message: string } | null }>;
    };
  };
};

/**
 * When did the last pipeline step publish the artifact? Every failure path
 * returns a `problem`, never a throw and never a guessed timestamp, because the
 * verdict for "cannot tell" is an alert.
 */
export async function probeDataplane(db: StorageClient): Promise<DataplaneProbe> {
  try {
    const { data, error } = await db.storage.from(BUCKET).list("", { limit: 100, search: ARTIFACT });
    if (error) return { updatedAt: null, problem: `Supabase Storage said: ${error.message}` };
    const row = (data ?? []).find((o) => o.name === ARTIFACT);
    if (!row) return { updatedAt: null, problem: null };
    if (!row.updated_at) {
      return { updatedAt: null, problem: `${ARTIFACT} exists but carries no last-written time.` };
    }
    return { updatedAt: row.updated_at, problem: null };
  } catch (e) {
    return { updatedAt: null, problem: `the storage read threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * When did THE WATCHDOG last start this workflow? `null` inside `readable: true`
 * means it never has. A failed read returns `readable: false`, which stops the
 * dispatch: the once-a-day bound has to be provable, not assumed.
 *
 * Only runs the watchdog started count. A run a person dispatched by hand is
 * skipped, because the bound exists to stop the WATCHDOG looping the runner, and
 * on 2026-08-28 a manual run 20.8 hours earlier spent that budget while the pool
 * sat 15.6 hours stale. The marker comes from the workflow's run-name; see
 * WATCHDOG_RUN_MARKER. One page is read rather than one run, since manual runs
 * can now sit in front of the watchdog's own.
 */
async function lastDispatchedRun(
  repo: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ readable: boolean; lastDispatchAt: string | null }> {
  try {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=30`;
    const res = await fetchImpl(url, { headers: githubHeaders(token, GITHUB_CALLER) });
    if (!res.ok) {
      console.warn(`[scrape-watchdog] GitHub runs ${res.status}:`, await res.text().catch(() => ""));
      return { readable: false, lastDispatchAt: null };
    }
    const body = (await res.json()) as {
      workflow_runs?: { created_at?: string | null; name?: string | null; display_title?: string | null }[];
    };
    // The list arrives newest first, so the first match is the latest restart.
    const mine = (body.workflow_runs ?? []).find((r) => isWatchdogRestart(r));
    return { readable: true, lastDispatchAt: mine?.created_at ?? null };
  } catch (e) {
    console.warn("[scrape-watchdog] GitHub runs fetch failed:", e);
    return { readable: false, lastDispatchAt: null };
  }
}

/**
 * The two things this endpoint reaches the outside world with. Both default to
 * the real ones, so production behaviour is untouched and Vercel still calls the
 * handler with two arguments. A test passes fakes and can then watch the wiring
 * itself: that a refused request never reads Storage, and that the workflow is
 * started only when the decision said to start it. Same injection shape as
 * confirmGmailForwarding in api/inbound-email.ts.
 */
export type WatchdogDeps = {
  createStorageClient?: (url: string, key: string) => StorageClient;
  fetchImpl?: typeof fetch;
};

export async function handler(req: Req, res: Res, deps: WatchdogDeps = {}): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const authError = cronAuthResult(
    [process.env.CRON_SECRET, process.env.CRON_SECRET_DB],
    req.headers["authorization"],
  );
  if (authError) {
    res.status(authError.status).json({ error: authError.error });
    return;
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_ALERT_EMAIL || DEFAULT_OWNER_EMAIL;
  const dispatchToken = (process.env.SCRAPE_DISPATCH_TOKEN ?? "").trim();
  const repo = process.env.SCRAPE_DISPATCH_REPO || DEFAULT_REPO;
  if (!supabaseUrl || !serviceKey) {
    // A misconfigured watchdog is a dead watchdog, and it would die without a
    // word. Report it, and email it too when there is any way to.
    reportApiError("[scrape-watchdog] cannot run: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    if (resendKey) {
      await sendEmail(
        resendKey,
        ownerEmail,
        "Northgoing scrape watchdog: the watchdog itself cannot run",
        [
          "The scrape watchdog could not start, so nothing is checking that the daily job scrape ran.",
          "",
          "Its Supabase settings are missing: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set on the deployment.",
          "Until that is fixed, check the Scrape jobs workflow in the Actions tab by hand.",
        ].join("\n"),
        doFetch,
      );
    }
    res.status(500).json({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }
  const admin: StorageClient = deps.createStorageClient
    ? deps.createStorageClient(supabaseUrl, serviceKey)
    : createClient(supabaseUrl, serviceKey);

  const now = new Date();
  const probe = await probeDataplane(admin);
  const verdict = decideDataplaneFreshness(probe, now.getTime());

  // The run history is only read when there is something to act on and a token
  // to act with. A healthy morning costs one storage read and nothing else.
  const history =
    verdict.alert && dispatchToken.length > 0
      ? await lastDispatchedRun(repo, dispatchToken, doFetch)
      : { readable: false, lastDispatchAt: null };

  const decision = decideDispatch({
    alert: verdict.alert,
    tokenPresent: dispatchToken.length > 0,
    runHistoryReadable: history.readable,
    lastDispatchAt: history.lastDispatchAt,
    nowMs: now.getTime(),
  });

  // The restart is attempted BEFORE the email is composed, so the email can say
  // what actually happened. `null` means no restart was attempted at all.
  // `reason` is what marks the run as the watchdog's own in the run list, so
  // the once-a-day bound above can find it again tomorrow.
  let dispatched: boolean | null = null;
  if (decision.dispatch) {
    dispatched = await dispatchWorkflow({
      repo,
      token: dispatchToken,
      reason: WATCHDOG_DISPATCH_REASON,
      caller: GITHUB_CALLER,
      fetchImpl: doFetch,
    });
  }

  let emailed = false;
  if (verdict.alert) {
    if (!resendKey) {
      console.warn("[scrape-watchdog] alert tripped but RESEND_API_KEY is missing; not emailed");
      reportApiError("[scrape-watchdog] alert tripped but RESEND_API_KEY is missing", {
        state: verdict.state,
      });
    } else {
      emailed = await sendEmail(
        resendKey,
        ownerEmail,
        buildWatchdogSubject(verdict, decision, dispatched),
        buildWatchdogBody(verdict, decision, now.toISOString(), dispatched),
        doFetch,
      );
    }
  }

  const summary = {
    state: verdict.state,
    alert: verdict.alert,
    ageHours: verdict.ageHours,
    dataplaneUpdatedAt: probe.updatedAt,
    dispatchPlanned: decision.dispatch,
    dispatched: dispatched === true,
    dispatchFailed: dispatched === false,
    emailed,
  };
  console.log("[scrape-watchdog]", JSON.stringify({ ...summary, reasons: verdict.reasons }));
  setRunSummary(summary);

  res.status(200).json({ ok: true, ...summary, reasons: verdict.reasons, dispatchReason: decision.reason });
}

export default withSentry("scrape-watchdog", handler);

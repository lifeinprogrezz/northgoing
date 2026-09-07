// Scrape watchdog (2026-08-27) — pure decision + email text, no input/output.
// api/scrape-watchdog.ts reads the dataplane artifact's Storage timestamp, hands
// the numbers here, and either emails the owner or re-dispatches the workflow.
//
// WHY THIS EXISTS. The free GitHub Actions scheduler starved on 2026-08-27: not
// one scheduled run fired between 03:00 and 11:00 UTC, GitHub reported no
// incident, and every manual trigger ran green. Three workers moved to pg_cron
// that day (nightly, score-backlog, spend-alert). The scrape workflow could not
// follow them, because it is a ten-step Node pipeline that needs a runner, the
// service-role key and minutes of runtime, and pg_cron can only make one HTTP
// call. So the scrape keeps its GitHub schedule and gets a watchdog instead.
// (2026-09-07: the daily start moved to pg_cron as well, through
// api/scrape-dispatch.ts, after GitHub's schedule fired late seven mornings
// running. This watchdog is unchanged and stays the guard for the morning that
// dispatch never reaches GitHub.)
//
// THE SIGNAL. The last step of the scrape workflow publishes the dataplane to
// Supabase Storage. Because it is the LAST step, a fresh timestamp on
// dataplane.json proves the whole chain finished, not merely that it started.
// A stale timestamp is the failure signal, and no new ledger table is needed.
//
// FAIL-SAFE DIRECTION, and this is the rule everything below serves: an alert
// that fires wrongly costs one email. A watchdog that stays quiet through a real
// outage costs a day of the product, because no new jobs enter the pool and the
// pool is the product. So whenever the check CANNOT TELL — the Storage row is
// missing, the read failed, the timestamp will not parse, the clock reads in the
// future — the verdict is "unknown" and it ALERTS. Health is never assumed.
// Pinned by src/lib/scrapeWatchdog.test.ts. Rule and code move together.

/**
 * The dataplane must have been rewritten within this many hours for the pipeline
 * to count as healthy. The scrape workflow starts at 03:47 UTC and this check
 * runs at 05:15 UTC — before the 06:00 nightly scorer, so a restart republishes
 * the pool in time for the digest. A run that succeeded this morning is about
 * 1.5 hours old and a run that never happened is about 25.5 hours old. Twelve
 * hours sits well clear of both, so neither a slow run nor an early check can
 * move the verdict.
 */
export const STALE_AFTER_HOURS = 12;

/**
 * The workflow is re-dispatched at most once in this many hours. A failure that
 * repeats must cost one run and one email a day, never a loop of runs.
 *
 * Strictly less than a day on purpose (2026-08-30). The check runs once a day at
 * the same minute, so its own restart from the previous morning is always
 * ~23.99 hours old at the next check. At 24 the guard read that as "already
 * started 24 hours ago", declined, and a stale morning after a stale morning was
 * not restarted. 20 still bounds a repeating failure to one run a day.
 */
export const DISPATCH_MIN_GAP_HOURS = 20;

/**
 * The name a run carries when THIS watchdog started it. The scrape workflow sets
 * its run-name from the `reason` dispatch input, so a restart the watchdog asked
 * for is legible in the run list and a run a person started by hand is not.
 *
 * WHY THIS EXISTS (2026-08-28). The once-a-day bound above is a bound on the
 * WATCHDOG's restarts: it stops a repeating failure from looping the runner. The
 * first version proved that bound by reading the newest `workflow_dispatch` run,
 * which counts every hand-started run too. On 2026-08-28 the pool was 15.6 hours
 * stale, the watchdog emailed correctly, and it then declined to restart anything
 * because a PERSON had dispatched the same workflow 20.8 hours earlier. The guard
 * spent its daily budget on somebody else's run, on the one morning the restart
 * was the whole point. A manual run must never stand in for the watchdog's own.
 */
export const WATCHDOG_RUN_MARKER = "watchdog restart";

/** The value the watchdog sends as the workflow's `reason` input. */
export const WATCHDOG_DISPATCH_REASON = "watchdog";

/** One row of the workflow-run list, narrowed to the names a run is known by. */
export type WorkflowRunName = { name?: string | null; display_title?: string | null };

/**
 * Did the watchdog start this run, as opposed to a person? Matches the marker in
 * either name GitHub reports, because `run-name` lands in `display_title` and,
 * for a named workflow, in `name` as well. Case-insensitive: the marker is read,
 * never parsed for meaning. Pinned by scrapeWatchdog.test.ts.
 */
export function isWatchdogRestart(run: WorkflowRunName): boolean {
  const marker = WATCHDOG_RUN_MARKER.toLowerCase();
  return [run.display_title, run.name].some((n) => (n ?? "").toLowerCase().includes(marker));
}

/**
 * A timestamp up to this far in the future is read as "now" rather than as a
 * broken clock. Beyond it, the two clocks disagree enough that the age is not
 * trustworthy, so the verdict is unknown and it alerts.
 */
export const CLOCK_SKEW_TOLERANCE_MINUTES = 5;

/** What the endpoint managed to read about the published dataplane artifact. */
export type DataplaneProbe = {
  /** When Storage says dataplane.json was last written. Null when unreadable. */
  updatedAt: string | null;
  /** Why the read failed, in plain words. Null when the read worked. */
  problem: string | null;
};

export type WatchdogState = "fresh" | "stale" | "unknown";

export type WatchdogVerdict = {
  /** True whenever the owner should hear about this. Unknown always alerts. */
  alert: boolean;
  state: WatchdogState;
  /** Plain-language lines for the email body. */
  reasons: string[];
  /** Hours since the artifact was written, or null when that is not knowable. */
  ageHours: number | null;
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Is the published dataplane fresh enough to prove the scrape pipeline ran?
 * Pure: takes the probe and the clock, returns the verdict. Unknown alerts.
 */
export function decideDataplaneFreshness(
  probe: DataplaneProbe,
  nowMs: number,
  staleAfterHours: number = STALE_AFTER_HOURS,
): WatchdogVerdict {
  if (probe.problem) {
    return {
      alert: true,
      state: "unknown",
      reasons: [
        `The watchdog could not read the dataplane artifact, so it cannot tell whether the scrape ran: ${probe.problem}`,
        "Treating this as a failure on purpose. Silence during a real outage is the expensive mistake.",
      ],
      ageHours: null,
    };
  }

  if (!probe.updatedAt) {
    return {
      alert: true,
      state: "unknown",
      reasons: [
        "There is no dataplane.json in the dataplane storage bucket, so the last step of the scrape pipeline has no record of finishing.",
      ],
      ageHours: null,
    };
  }

  const writtenMs = Date.parse(probe.updatedAt);
  if (!Number.isFinite(writtenMs)) {
    return {
      alert: true,
      state: "unknown",
      reasons: [`Storage returned a timestamp the watchdog cannot read: ${probe.updatedAt}`],
      ageHours: null,
    };
  }

  const ageHours = (nowMs - writtenMs) / 3_600_000;

  if (ageHours < -(CLOCK_SKEW_TOLERANCE_MINUTES / 60)) {
    return {
      alert: true,
      state: "unknown",
      reasons: [
        `The dataplane says it was written at ${probe.updatedAt}, which is in the future, so the two clocks disagree and the age cannot be trusted.`,
      ],
      ageHours: round1(ageHours),
    };
  }

  if (ageHours > staleAfterHours) {
    return {
      alert: true,
      state: "stale",
      reasons: [
        `The job pool has not been refreshed for ${round1(ageHours)} hours. The scrape workflow publishes the dataplane as its last step, so this means the daily run did not finish.`,
        `Anything over ${staleAfterHours} hours counts as a miss. The workflow is scheduled for 03:47 UTC and this check runs at 05:15 UTC.`,
      ],
      ageHours: round1(ageHours),
    };
  }

  return {
    alert: false,
    state: "fresh",
    reasons: [`The dataplane was refreshed ${round1(ageHours)} hours ago, so the scrape pipeline finished.`],
    ageHours: round1(ageHours),
  };
}

export type DispatchInput = {
  /** The freshness verdict. Only an alerting verdict can lead to a dispatch. */
  alert: boolean;
  /** Is there a GitHub token with actions write permission in the environment? */
  tokenPresent: boolean;
  /**
   * Could the recent run history be read? False when the GitHub call failed.
   * Without it the once-a-day bound cannot be proven, so nothing is dispatched.
   */
  runHistoryReadable: boolean;
  /**
   * When THE WATCHDOG last started the workflow, or null when it never has.
   * Runs a person dispatched by hand do not belong here: the caller filters them
   * out with isWatchdogRestart before filling this in. See WATCHDOG_RUN_MARKER.
   */
  lastDispatchAt: string | null;
  nowMs: number;
  minGapHours?: number;
};

export type DispatchDecision = {
  dispatch: boolean;
  /** Plain-language line for the email body. */
  reason: string;
};

/**
 * Should the watchdog start the scrape workflow itself?
 *
 * The alert side fails open (when unsure, send the email). This side fails
 * CLOSED (when unsure, do not start anything). The owner still hears about it
 * either way, and a workflow that cannot prove it has stayed inside its
 * once-a-day budget does not run.
 */
export function decideDispatch(input: DispatchInput): DispatchDecision {
  const minGapHours = input.minGapHours ?? DISPATCH_MIN_GAP_HOURS;

  if (!input.alert) {
    return { dispatch: false, reason: "Nothing to do. The pipeline is healthy." };
  }
  if (!input.tokenPresent) {
    return {
      dispatch: false,
      reason:
        "No GitHub token is configured, so the watchdog can only report this. Add SCRAPE_DISPATCH_TOKEN to let it restart the workflow on its own.",
    };
  }
  if (!input.runHistoryReadable) {
    return {
      dispatch: false,
      reason:
        "The watchdog could not read the workflow's recent runs, so it cannot prove it has not already started one today. It is holding off rather than risking a loop.",
    };
  }
  if (input.lastDispatchAt) {
    const lastMs = Date.parse(input.lastDispatchAt);
    if (!Number.isFinite(lastMs)) {
      return {
        dispatch: false,
        reason: `The last run carries a timestamp the watchdog cannot read (${input.lastDispatchAt}), so it is holding off rather than risking a loop.`,
      };
    }
    const sinceHours = (input.nowMs - lastMs) / 3_600_000;
    if (sinceHours < minGapHours) {
      return {
        dispatch: false,
        reason: `The watchdog already started this workflow ${round1(sinceHours)} hours ago. It starts it at most once every ${minGapHours} hours, so a failure that repeats cannot loop the runner.`,
      };
    }
  }
  return { dispatch: true, reason: "Starting the scrape workflow now." };
}

/**
 * What actually happened on the dispatch side, as opposed to what was decided.
 * `null` means no restart was attempted, so the decision line stands as written.
 * `true` means GitHub accepted it. `false` means GitHub refused it or the call
 * never landed.
 *
 * The email must never claim a restart that did not happen. A person who reads
 * "restarting the scrape" stops looking, and if the restart was refused the day
 * is lost exactly as if the watchdog had said nothing. So the outcome, not the
 * intention, is what the owner reads. Pinned by scrapeWatchdog.test.ts.
 */
export type DispatchOutcome = boolean | null;

/** The one line about the restart that the subject and the body both build on. */
export function describeDispatch(dispatch: DispatchDecision, outcome: DispatchOutcome): {
  restarted: boolean;
  failed: boolean;
  line: string;
} {
  if (!dispatch.dispatch || outcome === null) {
    return { restarted: false, failed: false, line: dispatch.reason };
  }
  if (outcome) return { restarted: true, failed: false, line: dispatch.reason };
  return {
    restarted: false,
    failed: true,
    line: "The watchdog tried to restart the scrape workflow and GitHub refused the request, so nothing was started. Start it by hand from the Actions tab.",
  };
}

export function buildWatchdogSubject(
  verdict: WatchdogVerdict,
  dispatch: DispatchDecision,
  outcome: DispatchOutcome = null,
): string {
  const head = verdict.state === "stale" ? "the job pool did not refresh" : "cannot confirm the job pool refreshed";
  const told = describeDispatch(dispatch, outcome);
  const tail = told.restarted ? " (restarting the scrape)" : told.failed ? " (could not restart it)" : "";
  return `Northgoing scrape watchdog: ${head}${tail}`;
}

export function buildWatchdogBody(
  verdict: WatchdogVerdict,
  dispatch: DispatchDecision,
  checkedAt: string,
  outcome: DispatchOutcome = null,
): string {
  const told = describeDispatch(dispatch, outcome);
  const lines = [
    verdict.state === "stale"
      ? "The daily scrape did not publish a fresh job pool."
      : "The watchdog could not confirm that the daily scrape published a fresh job pool.",
    "",
    ...verdict.reasons,
    "",
    told.line,
    "",
    "What to check, in this order:",
    "1. The Scrape jobs workflow in the repository's Actions tab. A red run tells you which step broke.",
    "2. No run at all means the 03:47 pg_cron dispatch did not reach GitHub (api/scrape-dispatch.ts, pg_cron job northgoing-scrape-dispatch). Start it by hand from the same tab.",
    "3. The job pool keeps serving yesterday's artifact meanwhile, so the site stays up. It just stops growing.",
    "",
    `Checked at ${checkedAt}.`,
  ];
  return lines.join("\n");
}

// Daily spend alert (issue #137) — pure decision + email text, no I/O.
// api/spend-alert.ts reads `usage_events` through the `spend_alert_snapshot()`
// RPC, hands the numbers here, and emails the owner when a threshold trips.
//
// Signal only. No enforcement, no per-user cap — nothing a real user can hit.
// The thresholds are deliberately dumb: the point is that the Anthropic invoice
// is not the first notification of a cost step function (a RUBRIC_VERSION bump,
// a catalogue expansion).

/** Yesterday alerts when it exceeds this multiple of the trailing-7-day median. */
export const DAY_MULTIPLIER = 3;
/** One user alerts when their day exceeds this multiple of the median user's day. */
export const USER_MULTIPLIER = 10;
/**
 * Floor under which the day check stays quiet. Against an empty history the
 * median is 0 and any cent would be "more than 3x the median"; a brand-new
 * deployment must not page the owner over $0.04.
 */
export const MIN_ALERT_USD = 1;

export type UserDay = { userId: string; cost: number };

export type SpendSnapshot = {
  /** Yesterday's total, UTC day. */
  yesterday: number;
  /** Month-to-date total, UTC month of "now". */
  monthToDate: number;
  /** Daily totals for the 7 UTC days BEFORE yesterday (zero-filled). */
  trailingDays: number[];
  /** Yesterday's per-user totals. REAL users only: rows with no user_id are pipeline work. */
  yesterdayUsers: UserDay[];
  /**
   * Yesterday's spend carrying no user_id (extract, enrich, jd-backfill, the
   * scrape's own scoring). Reported on its own line; never a "user" in the
   * outlier check. 2026-09-07 it read "One user (anonymous) cost $0.66".
   */
  systemYesterday?: number;
};

export type SpendDecision = {
  alert: boolean;
  reasons: string[];
  dayMedian: number;
  /** yesterday / dayMedian, or null when the median is 0. */
  dayMultiple: number | null;
  userMedian: number;
  topUser: UserDay | null;
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const times = (n: number): string => `${n.toFixed(1)}x`;

export function decideSpendAlert(s: SpendSnapshot): SpendDecision {
  const dayMedian = median(s.trailingDays);
  const dayMultiple = dayMedian > 0 ? s.yesterday / dayMedian : null;
  const userCosts = s.yesterdayUsers.map((u) => u.cost);
  const userMedian = median(userCosts);
  const topUser = s.yesterdayUsers.reduce<UserDay | null>((top, u) => (top === null || u.cost > top.cost ? u : top), null);

  const reasons: string[] = [];
  if (s.yesterday >= MIN_ALERT_USD && s.yesterday > DAY_MULTIPLIER * dayMedian) {
    reasons.push(
      dayMultiple === null
        ? `Yesterday cost ${usd(s.yesterday)} against a trailing-7-day median of $0.00.`
        : `Yesterday cost ${usd(s.yesterday)}, ${times(dayMultiple)} the trailing-7-day median of ${usd(dayMedian)} (threshold ${DAY_MULTIPLIER}x).`,
    );
  }
  if (topUser && s.yesterdayUsers.length > 1 && topUser.cost > USER_MULTIPLIER * userMedian) {
    const vsMedian =
      userMedian > 0
        ? `${times(topUser.cost / userMedian)} the median user's day of ${usd(userMedian)}`
        : "against a median user's day of $0.00";
    reasons.push(
      `One user (${topUser.userId}) cost ${usd(topUser.cost)} yesterday, ${vsMedian} (threshold ${USER_MULTIPLIER}x).`,
    );
  }

  return { alert: reasons.length > 0, reasons, dayMedian, dayMultiple, userMedian, topUser };
}

export function buildSpendAlertSubject(d: SpendDecision, s: SpendSnapshot): string {
  const multiple = d.dayMultiple === null ? "no history" : `${times(d.dayMultiple)} the median day`;
  return `Spend alert: ${usd(s.yesterday)} yesterday (${multiple})`;
}

/** Plain text. Expanded words, no markup, no em-dashes. */
export function buildSpendAlertBody(d: SpendDecision, s: SpendSnapshot): string {
  const lines: string[] = [
    "Sponsored-compute spend tripped a threshold yesterday (UTC).",
    "",
    ...d.reasons.map((r) => `- ${r}`),
    "",
    `Yesterday: ${usd(s.yesterday)}`,
    `Trailing-7-day median (the 7 days before yesterday): ${usd(d.dayMedian)}`,
    `Trailing days, oldest first: ${s.trailingDays.map(usd).join(", ")}`,
    `Month to date: ${usd(s.monthToDate)}`,
    `System spend (pipeline, no user): ${usd(s.systemYesterday ?? 0)}`,
    `Users with spend yesterday: ${s.yesterdayUsers.length}`,
    `Median user's day: ${usd(d.userMedian)}`,
    d.topUser ? `Top user: ${d.topUser.userId} at ${usd(d.topUser.cost)}` : "Top user: none",
    "",
    "Likely self-inflicted causes: a rubric version bump re-scoring every user's slice, or a catalogue expansion.",
    "This is a signal only. No enforcement and no per-user cap exist; nothing was blocked.",
    "Check the Anthropic console balance and auto-reload before the invoice does it for you.",
  ];
  return lines.join("\n");
}

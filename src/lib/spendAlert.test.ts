import { describe, it, expect } from "vitest";
import {
  DAY_MULTIPLIER,
  USER_MULTIPLIER,
  MIN_ALERT_USD,
  median,
  decideSpendAlert,
  buildSpendAlertSubject,
  buildSpendAlertBody,
  type SpendSnapshot,
} from "./spendAlert";

const quiet: SpendSnapshot = {
  yesterday: 2.7,
  monthToDate: 35.03,
  trailingDays: [2.5, 2.9, 2.6, 3.1, 2.4, 2.8, 2.7],
  yesterdayUsers: [
    { userId: "u1", cost: 1.0 },
    { userId: "u2", cost: 0.9 },
    { userId: "u3", cost: 0.8 },
  ],
};

describe("median", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("decideSpendAlert", () => {
  it("stays quiet on a normal day", () => {
    const d = decideSpendAlert(quiet);
    expect(d.alert).toBe(false);
    expect(d.reasons).toEqual([]);
    expect(d.dayMedian).toBeCloseTo(2.7);
    expect(d.userMedian).toBeCloseTo(0.9);
    expect(d.topUser).toEqual({ userId: "u1", cost: 1.0 });
  });

  it("alerts when yesterday exceeds the day multiplier times the trailing-7-day median", () => {
    const d = decideSpendAlert({ ...quiet, yesterday: 2.7 * DAY_MULTIPLIER + 0.01 });
    expect(d.alert).toBe(true);
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]).toMatch(/median/i);
  });

  it("does not alert at exactly the day multiplier (strictly greater)", () => {
    const d = decideSpendAlert({ ...quiet, yesterday: 2.7 * DAY_MULTIPLIER });
    expect(d.alert).toBe(false);
  });

  it("alerts when one user exceeds the user multiplier times the median user's day", () => {
    const d = decideSpendAlert({
      ...quiet,
      yesterdayUsers: [...quiet.yesterdayUsers, { userId: "whale", cost: 0.95 * USER_MULTIPLIER + 0.01 }],
    });
    expect(d.alert).toBe(true);
    expect(d.topUser?.userId).toBe("whale");
    expect(d.reasons).toHaveLength(1);
    expect(d.reasons[0]).toMatch(/user/i);
  });

  it("reports both reasons when both trip", () => {
    const d = decideSpendAlert({
      ...quiet,
      yesterday: 50,
      yesterdayUsers: [...quiet.yesterdayUsers, { userId: "whale", cost: 40 }],
    });
    expect(d.alert).toBe(true);
    expect(d.reasons).toHaveLength(2);
  });

  it("pipeline spend with no user is reported as system and never counts as a user", () => {
    // 2026-09-07 live: extract $0.43 + enrich $0.23 carried no user_id and the mail read
    // "One user (anonymous) cost $0.66 yesterday, 15.5x the median user's day".
    const d = decideSpendAlert({
      yesterday: 0.81,
      monthToDate: 4.2,
      trailingDays: [0.56, 0.24, 0.6, 0.7, 0.5, 0.65, 0.58],
      systemYesterday: 0.66,
      yesterdayUsers: [
        { userId: "u1", cost: 0.06 },
        { userId: "u2", cost: 0.04 },
        { userId: "u3", cost: 0.03 },
        { userId: "u4", cost: 0.02 },
      ],
    });
    expect(d.alert).toBe(false);
    expect(d.topUser?.userId).toBe("u1");
    expect(d.reasons).toHaveLength(0);
    const body = buildSpendAlertBody(d, {
      yesterday: 0.81,
      monthToDate: 4.2,
      trailingDays: [0.56, 0.24, 0.6, 0.7, 0.5, 0.65, 0.58],
      systemYesterday: 0.66,
      yesterdayUsers: [{ userId: "u1", cost: 0.06 }],
    });
    expect(body).toMatch(/System spend \(pipeline, no user\): \$0\.66/);
    expect(body).not.toMatch(/anonymous/);
  });

  it("still flags a real whale when system spend is present", () => {
    const d = decideSpendAlert({
      ...quiet,
      systemYesterday: 5,
      yesterdayUsers: [...quiet.yesterdayUsers, { userId: "whale", cost: 0.95 * USER_MULTIPLIER + 0.01 }],
    });
    expect(d.alert).toBe(true);
    expect(d.topUser?.userId).toBe("whale");
  });

  it("never alerts on a single user (the median user IS the top user)", () => {
    const d = decideSpendAlert({ ...quiet, yesterdayUsers: [{ userId: "solo", cost: 2.7 }] });
    expect(d.alert).toBe(false);
  });

  it("ignores cents against an empty history (floor)", () => {
    const d = decideSpendAlert({
      yesterday: MIN_ALERT_USD / 2,
      monthToDate: 0.1,
      trailingDays: [0, 0, 0, 0, 0, 0, 0],
      yesterdayUsers: [],
    });
    expect(d.alert).toBe(false);
  });

  it("alerts on real spend against an empty history", () => {
    const d = decideSpendAlert({
      yesterday: MIN_ALERT_USD + 1,
      monthToDate: 2,
      trailingDays: [0, 0, 0, 0, 0, 0, 0],
      yesterdayUsers: [],
    });
    expect(d.alert).toBe(true);
  });
});

describe("email", () => {
  const snap = { ...quiet, yesterday: 12.34 };
  const tripped = decideSpendAlert(snap);

  it("subject names the amount and the multiple", () => {
    const s = buildSpendAlertSubject(tripped, snap);
    expect(s).toContain("$12.34");
    expect(s).toMatch(/4\.6x/);
    expect(s).not.toContain("—");
  });

  it("body is plain text with every number, expanded words, and no em-dashes", () => {
    const b = buildSpendAlertBody(tripped, snap);
    expect(b).toContain("$12.34");
    expect(b).toContain("$35.03");
    expect(b).toContain("$2.70");
    expect(b).toContain("u1");
    expect(b).toContain("median");
    expect(b).not.toContain("—");
    expect(b).not.toContain("<");
    expect(b).not.toMatch(/\bMTD\b/);
    expect(b).toMatch(/month to date/i);
    expect(b).toMatch(/no enforcement/i);
  });
});

// The snapshot RPC groups yesterday's usage_events by user_id, and the pipeline's
// own work (extract, enrich, jd-backfill) carries NULL. Before 2026-09-08 that
// row became a user called "anonymous" and tripped the 10x-median check
// ("One user (anonymous) cost $0.66 yesterday, 15.5x the median user's day").
import { describe, expect, it } from "vitest";
import { toSnapshot } from "../../api/spend-alert";
import { decideSpendAlert, buildSpendAlertBody } from "@/lib/spendAlert";

describe("spend-alert snapshot wiring", () => {
  it("routes NULL user_id rows to systemYesterday and keeps only real users", () => {
    const s = toSnapshot({
      yesterday: "0.81",
      month_to_date: "4.2",
      trailing_days: [0.56, 0.24, 0.6, 0.7, 0.5, 0.65, 0.58].map((cost, i) => ({ day: `2026-08-3${i}`, cost })),
      yesterday_users: [
        { user_id: null, cost: "0.66" },
        { user_id: "u1", cost: "0.06" },
        { user_id: "u2", cost: 0.04 },
        { user_id: "u3", cost: 0.03 },
        { user_id: "u4", cost: 0.02 },
      ],
    });
    expect(s.systemYesterday).toBeCloseTo(0.66, 6);
    expect(s.yesterdayUsers.map((u) => u.userId)).toEqual(["u1", "u2", "u3", "u4"]);
    const d = decideSpendAlert(s);
    expect(d.alert).toBe(false);
    expect(buildSpendAlertBody(d, s)).toMatch(/System spend \(pipeline, no user\): \$0\.66/);
  });

  it("a day with only pipeline spend has zero users and no user reason", () => {
    const s = toSnapshot({ yesterday: 0.5, yesterday_users: [{ user_id: null, cost: 0.5 }] });
    expect(s.yesterdayUsers).toEqual([]);
    expect(s.systemYesterday).toBe(0.5);
    expect(decideSpendAlert(s).reasons.some((r) => /user/i.test(r))).toBe(false);
  });
});

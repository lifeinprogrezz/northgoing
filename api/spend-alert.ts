// Daily spend alert (issue #137) — sibling of api/nightly.ts / api/score-backlog.ts.
// Reads yesterday's sponsored-compute spend from `usage_events` through the
// `spend_alert_snapshot()` RPC (summed in the database; see the migration), and
// emails the owner through Resend when yesterday exceeds 3x the trailing-7-day
// median or one user exceeds 10x the median user's day (src/lib/spendAlert.ts).
// Invoked once a day at 10:00 UTC by .github/workflows/spend-alert.yml.
//
// Signal only: no enforcement, no per-user cap. A manual call always returns the
// computed numbers so the deltas are visible even when nothing tripped.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY / CRON_SECRET
// (same contract as api/nightly.ts) + optional OWNER_ALERT_EMAIL.
import { createClient } from "@supabase/supabase-js";
import { cronAuthResult } from "../src/lib/nightly.js";
import { BRAND_NAME } from "../src/lib/brandName.js";
import {
  decideSpendAlert,
  buildSpendAlertSubject,
  buildSpendAlertBody,
  type SpendSnapshot,
} from "../src/lib/spendAlert.js";
// #145: thrown errors + the explicit failure lines below go to Sentry (ids and
// counts only — see src/lib/apiSentry.ts). No DSN → every call is a no-op.
import { reportApiError, setRunSummary, withSentry } from "../src/lib/apiSentry.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { status: (code: number) => Res; json: (body: unknown) => void };

// Same sender as the nightly digest; both must move together.
const EMAIL_FROM = `${BRAND_NAME} <matches@northgoing.com>`;
const DEFAULT_OWNER_EMAIL = "hello@lifeinprogrezz.com";

type SnapshotRow = {
  yesterday?: number | string | null;
  month_to_date?: number | string | null;
  trailing_days?: { day: string; cost: number | string }[] | null;
  yesterday_users?: { user_id: string | null; cost: number | string }[] | null;
};

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// Rows with no user_id are the pipeline's own work (extract, enrich, jd-backfill).
// They go to `systemYesterday`, never into the per-user outlier check.
export function toSnapshot(row: SnapshotRow): SpendSnapshot {
  const users = row.yesterday_users ?? [];
  return {
    yesterday: num(row.yesterday),
    monthToDate: num(row.month_to_date),
    trailingDays: (row.trailing_days ?? []).map((d) => num(d.cost)),
    systemYesterday: users.filter((u) => u.user_id == null).reduce((sum, u) => sum + num(u.cost), 0),
    yesterdayUsers: users.filter((u) => u.user_id != null).map((u) => ({ userId: u.user_id as string, cost: num(u.cost) })),
  };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Fire one Resend notification. Fail-soft: logs + returns false, never throws. */
async function sendEmail(apiKey: string, to: string, subject: string, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
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
      console.warn(`[spend-alert] Resend ${res.status}:`, await res.text().catch(() => ""));
      reportApiError(`[spend-alert] Resend non-ok ${res.status}`, { status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[spend-alert] Resend fetch failed:", e);
    return false;
  }
}

async function handler(req: Req, res: Res): Promise<void> {
  const authError = cronAuthResult([process.env.CRON_SECRET, process.env.CRON_SECRET_DB], req.headers["authorization"]);
  if (authError) {
    res.status(authError.status).json({ error: authError.error });
    return;
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_ALERT_EMAIL || DEFAULT_OWNER_EMAIL;
  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    return;
  }
  const admin = createClient(supabaseUrl, serviceKey);

  const { data, error } = await admin.rpc("spend_alert_snapshot");
  if (error) {
    console.error("[spend-alert] snapshot read failed:", error.message);
    reportApiError("[spend-alert] snapshot read failed", { code: error.code, message: error.message });
    res.status(500).json({ error: `spend_alert_snapshot failed: ${error.message}` });
    return;
  }
  const snapshot = toSnapshot((data ?? {}) as SnapshotRow);
  const decision = decideSpendAlert(snapshot);

  const numbers = {
    yesterday: snapshot.yesterday,
    monthToDate: snapshot.monthToDate,
    trailingDays: snapshot.trailingDays,
    dayMedian: decision.dayMedian,
    dayMultiple: decision.dayMultiple,
    systemYesterday: snapshot.systemYesterday,
    usersYesterday: snapshot.yesterdayUsers.length,
    userMedian: decision.userMedian,
    topUser: decision.topUser,
  };
  console.log("[spend-alert]", JSON.stringify({ alert: decision.alert, reasons: decision.reasons, ...numbers }));
  setRunSummary({ alert: decision.alert, reasons: decision.reasons, ...numbers });

  let emailed = false;
  if (decision.alert) {
    if (!resendKey) {
      console.warn("[spend-alert] alert tripped but RESEND_API_KEY is missing; not emailed");
    } else {
      emailed = await sendEmail(
        resendKey,
        ownerEmail,
        buildSpendAlertSubject(decision, snapshot),
        buildSpendAlertBody(decision, snapshot),
      );
    }
  }

  res.status(200).json({ ok: true, alert: decision.alert, reasons: decision.reasons, emailed, ...numbers });
}

export default withSentry("spend-alert", handler);

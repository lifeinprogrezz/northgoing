// @vitest-environment node
//
// Runs supabase/migrations/20260907191000_merge_url_variant_rows.sql VERBATIM on an
// in-process Postgres (PGlite, WASM, no Docker) with a subset of the production
// schema and a fixture that holds every duplicate class the migration folds.
//
// Why this exists (review round 1 of PR #214, 2026-09-07). The migration is the
// riskiest change in that PR: it re-points job_id on scores / saved_jobs /
// dismissed_jobs / applications / artifacts, deletes conflict rows, retires jobs
// rows and rewrites urls. It shipped with a mutant table that rested on a scratch
// harness nobody could re-run, and the reviewers found two defects with their
// own harness that the scratch one had missed:
//   1. a group with NO canonical row got an age-chosen keeper whose url stayed
//      non-canonical, so the first scrape after canon-url.mjs shipped upserted
//      the canonical twin beside it: the duplicate came back the next morning
//      with the merged refs stranded on the stale row.
//   2. the trailing-slash rule stripped ONE slash, so a "/a//" row was rewritten
//      on run 1 and again on run 2 while the header claimed a rerun is a no-op.
// Both are pinned below, next to the keeper / tie / conflict rules the original
// mutant table covered, and the operator's dry-run and capture SQL
// (supabase/tests/) are held to the migration's key expression byte for byte.
//
// The schema is a SUBSET copied from supabase/schema-snapshot.json: the six
// tables the migration touches with their unique constraints, the artifacts
// partial unique index, the FK cascades, the applications BEFORE UPDATE trigger
// with an auth.uid() stub, and status_events (on delete set null) so the payload
// loss on a dropped application is visible. Columns the migration never reads
// are left out.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { canonUrl } from "../../scripts/canon-url.mjs";

const ROOT = process.cwd();
const MIGRATION = readFileSync(join(ROOT, "supabase/migrations/20260907191000_merge_url_variant_rows.sql"), "utf8");
const DRY_RUN = readFileSync(join(ROOT, "supabase/tests/merge_url_variant_rows_dry_run.sql"), "utf8");
const CAPTURE = readFileSync(join(ROOT, "supabase/tests/merge_url_variant_rows_capture.sql"), "utf8");

const SCHEMA = `
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.jobs (id uuid primary key default gen_random_uuid(), url text not null unique, company text not null default 'c', title text not null default 't', created_at timestamptz not null default now(), is_live boolean not null default true, source text);
create table public.scores (id uuid primary key default gen_random_uuid(), user_id uuid not null, job_id uuid not null references public.jobs(id) on delete cascade, rubric_version text not null default 'v1', scored_at timestamptz not null default now(), score numeric, unique (user_id, job_id, rubric_version));
create table public.saved_jobs (id uuid primary key default gen_random_uuid(), user_id uuid not null, job_id uuid not null references public.jobs(id) on delete cascade, saved_at timestamptz not null default now(), unique (user_id, job_id));
create table public.dismissed_jobs (id uuid primary key default gen_random_uuid(), user_id uuid not null, job_id uuid not null references public.jobs(id) on delete cascade, dismissed_at timestamptz not null default now(), unique (user_id, job_id));
create table public.applications (id uuid primary key default gen_random_uuid(), user_id uuid not null, job_id uuid not null references public.jobs(id) on delete cascade, status text not null default 'applied', applied_at timestamptz not null default now(), confirmed_at timestamptz, notes text, unique (user_id, job_id));
create table public.status_events (id uuid primary key default gen_random_uuid(), user_id uuid not null, application_id uuid references public.applications(id) on delete set null, to_status text not null default 'applied', changed_at timestamptz not null default now());
create table public.artifacts (id uuid primary key default gen_random_uuid(), user_id uuid not null, job_id uuid references public.jobs(id) on delete set null, kind text not null, updated_at timestamptz not null default now(), content jsonb not null default '{}');
create unique index artifacts_user_job_kind_idx on public.artifacts (user_id, job_id, kind) where job_id is not null;
create or replace function public.protect_applications_confirmed_at() returns trigger language plpgsql set search_path = '' as $$
begin
  if (select auth.uid()) is not null then
    if TG_OP = 'INSERT' then new.confirmed_at := null; else new.confirmed_at := old.confirmed_at; end if;
  end if;
  return new;
end; $$;
create trigger applications_protect_confirmed_at before insert or update on public.applications for each row execute function public.protect_applications_confirmed_at();
`;

/** Fixed uuids so the assertions read as names, not hashes. */
const J = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
const R = (n: number) => `00000000-0000-0000-0000-0000000002${String(n).padStart(2, "0")}`;
const U1 = "00000000-0000-0000-0000-000000000101";
const U2 = "00000000-0000-0000-0000-000000000102";

/**
 * Every class the migration knows, plus the two reviewer cases.
 *   J1/J2    personio pair, the canonical .de row is the NEWER one (keeper by form, not age)
 *   J3       lone personio .com with a query (rewritten; keeps its query)
 *   J4       lone canonical .de
 *   J5-J7    workable three-row group: canonical + `/Acme/j/ABC123/` + `?utm_source`
 *   J8/J9    workable group with NO canonical row and no tie: age-chosen keeper J8
 *            whose url must be rewritten (reviewer finding 1)
 *   J10/J11  trailing-slash pair whose canonical keeper is NOT live
 *   J12      lone personio .com (rewritten)
 *   J13      greenhouse with ?gh_jid= (exempt, untouched)
 *   J14      root path / (untouched)
 *   J15/J16  no canonical row and a created_at tie (skipped)
 *   J17      lone double-slash straggler `y//` (reviewer finding 2: one run, not three)
 */
const JOBS: Array<[number, string, string, boolean]> = [
  [1, "https://vytal.jobs.personio.com/job/111", "2026-08-01", true],
  [2, "https://vytal.jobs.personio.de/job/111", "2026-08-05", true],
  [3, "https://flatpay.jobs.personio.com/job/222?display=en", "2026-08-01", true],
  [4, "https://flatpay.jobs.personio.de/job/222", "2026-08-02", true],
  [5, "https://apply.workable.com/acme/j/abc123", "2026-07-01", true],
  [6, "https://apply.workable.com/Acme/j/ABC123/", "2026-07-02", true],
  [7, "https://apply.workable.com/acme/j/abc123?utm_source=x", "2026-07-03", true],
  [8, "https://apply.workable.com/Beta/j/DEF/", "2026-07-01", true],
  [9, "https://apply.workable.com/beta/j/def?utm=1", "2026-07-02", true],
  [10, "https://nordsecurity.com/careers/uuid-1/", "2026-08-01", true],
  [11, "https://nordsecurity.com/careers/uuid-1", "2026-08-02", false],
  [12, "https://accure.jobs.personio.com/job/333", "2026-08-01", true],
  [13, "https://boards.greenhouse.io/Acme/jobs/1?gh_jid=1", "2026-08-01", true],
  [14, "https://example.com/", "2026-08-01", true],
  [15, "https://jobs.lever.co/Tie/1", "2026-06-01", true],
  [16, "https://jobs.lever.co/tie/1/", "2026-06-01", true],
  [17, "https://acme.com/careers/y//", "2026-08-01", true],
];

async function loadFixture(db: PGlite) {
  await db.exec(SCHEMA);
  for (const [n, url, created, live] of JOBS) {
    await db.query("insert into public.jobs (id, url, created_at, is_live) values ($1, $2, $3, $4)", [J(n), url, created, live]);
  }
  const score = (id: string, user: string, job: string, at: string, value: number) =>
    db.query("insert into public.scores (id, user_id, job_id, rubric_version, scored_at, score) values ($1, $2, $3, 'v1', $4, $5)", [id, user, job, at, value]);
  // R1 conflicts with the keeper's own R2; R3 moves; R4 and R5 compete for one keeper slot; R6 moves to the age-chosen keeper.
  await score(R(1), U1, J(1), "2026-08-02", 1);
  await score(R(2), U1, J(2), "2026-08-06", 2);
  await score(R(3), U2, J(1), "2026-08-02", 3);
  await score(R(4), U1, J(6), "2026-07-02", 4);
  await score(R(5), U1, J(7), "2026-07-04", 5);
  await score(R(6), U1, J(9), "2026-07-03", 6);
  await db.query("insert into public.saved_jobs (id, user_id, job_id) values ($1, $2, $3)", [R(10), U1, J(10)]);
  await db.query("insert into public.dismissed_jobs (id, user_id, job_id) values ($1, $2, $3)", [R(20), U1, J(6)]);
  await db.query("insert into public.dismissed_jobs (id, user_id, job_id) values ($1, $2, $3)", [R(21), U1, J(5)]);
  await db.query("insert into public.applications (id, user_id, job_id, status, confirmed_at, notes) values ($1, $2, $3, 'interview', '2026-08-03', 'n1')", [R(30), U1, J(1)]);
  await db.query("insert into public.applications (id, user_id, job_id, status) values ($1, $2, $3, 'applied')", [R(31), U2, J(1)]);
  await db.query("insert into public.applications (id, user_id, job_id, status) values ($1, $2, $3, 'applied')", [R(32), U2, J(2)]);
  await db.query("insert into public.status_events (id, user_id, application_id) values ($1, $2, $3)", [R(35), U2, R(31)]);
  await db.query("insert into public.artifacts (id, user_id, job_id, kind) values ($1, $2, $3, 'cv')", [R(40), U1, J(1)]);
  await db.query("insert into public.artifacts (id, user_id, job_id, kind) values ($1, $2, $3, 'cv')", [R(41), U1, J(2)]);
  await db.query("insert into public.artifacts (id, user_id, job_id, kind) values ($1, $2, $3, 'letter')", [R(42), U2, J(1)]);
}

/** Runs the migration and returns its three `raise notice` lines. */
async function runMigration(db: PGlite): Promise<string[]> {
  const notices: string[] = [];
  await db.exec(MIGRATION, {
    onNotice: (n) => {
      if (String(n.message).startsWith("merge_url_variant_rows")) notices.push(String(n.message));
    },
  });
  return notices;
}

const TABLES = ["jobs", "scores", "saved_jobs", "dismissed_jobs", "applications", "status_events", "artifacts"];

async function dump(db: PGlite): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = (await db.query(`select * from public.${t} order by id`)).rows;
  return JSON.stringify(out);
}

type JobRow = { url: string; is_live: boolean };
type RefRow = { job_id: string | null };

/**
 * The normalized-key expression, sliced out of a SQL file: from `coalesce(` to
 * `) as canon`. The migration, the dry run and the capture must carry the same
 * one, or the operator's numbers describe a different merge than the one applied.
 */
function keyExpression(sql: string): string {
  const start = sql.indexOf("coalesce(");
  const end = sql.indexOf(") as canon", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 1).replace(/\s+/g, " ");
}

describe("merge_url_variant_rows: the migration on a fixture of every duplicate class", () => {
  let db: PGlite;
  let notices: string[];
  let dryRun: Record<string, number>;
  let capture: Array<{ kind: string; id: string; old_value: string | null; ref: string | null; was_live: boolean | null }>;

  const job = async (n: number) => (await db.query<JobRow>("select url, is_live from public.jobs where id = $1", [J(n)])).rows[0];
  const ref = async (table: string, id: string) => (await db.query<RefRow>(`select job_id from public.${table} where id = $1`, [id])).rows[0];

  beforeAll(async () => {
    db = new PGlite();
    await loadFixture(db);
    // The operator's order: dry run and capture BEFORE the migration.
    const dry = await db.exec(DRY_RUN);
    dryRun = Object.fromEntries(
      (dry[dry.length - 1].rows as Array<{ metric: string; value: string | number }>).map((r) => [r.metric, Number(r.value)]),
    );
    const cap = await db.exec(CAPTURE);
    capture = cap[cap.length - 1].rows as typeof capture;
    notices = await runMigration(db);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("reports what it did, per class", () => {
    expect(notices).toEqual([
      "merge_url_variant_rows: 5 group(s), 5 variant row(s) retired now (personio 1, trailing-slash 2, case 2), 1 group(s) skipped (no canonical row and a created_at tie), 1 keeper(s) chosen by age with no canonical-form row",
      "merge_url_variant_rows: variants in scope 5 (retired earlier or now); refs moved/dropped: scores 3/2, saved_jobs 1/0, dismissed_jobs 0/1, applications 1/1; artifacts moved 1, left on variant 1",
      "merge_url_variant_rows: 4 row(s) rewritten to the canonical url (personio 2, trailing-slash 2, case 0), 1 of them age-chosen keeper(s) of a group with no canonical row",
    ]);
  });

  it("keeper = the row whose url is already canonical, even when it is the newer one", async () => {
    const [j1, j2] = [await job(1), await job(2)];
    expect(j1.is_live).toBe(false);
    expect(j2).toEqual({ url: "https://vytal.jobs.personio.de/job/111", is_live: true });
  });

  it("a three-row group retires both variants and keeps the canonical row live", async () => {
    expect((await job(5)).is_live).toBe(true);
    expect((await job(6)).is_live).toBe(false);
    expect((await job(7)).is_live).toBe(false);
  });

  it("a group with no canonical row and a created_at tie is skipped, both rows untouched", async () => {
    expect(await job(15)).toEqual({ url: "https://jobs.lever.co/Tie/1", is_live: true });
    expect(await job(16)).toEqual({ url: "https://jobs.lever.co/tie/1/", is_live: true });
  });

  it("a variant retires even when its canonical keeper is not live (the posting goes invisible, as measured)", async () => {
    expect((await job(10)).is_live).toBe(false);
    expect((await job(11)).is_live).toBe(false);
  });

  it("scores: a conflict with the keeper's row is dropped, a move keeps its id, the newest of two competing variants wins", async () => {
    expect(await ref("scores", R(1))).toBeUndefined();
    expect((await ref("scores", R(3)))?.job_id).toBe(J(2));
    expect(await ref("scores", R(4))).toBeUndefined();
    expect((await ref("scores", R(5)))?.job_id).toBe(J(5));
  });

  it("saved_jobs moves to the keeper even when that keeper is not live; dismissed_jobs drops the conflict", async () => {
    expect((await ref("saved_jobs", R(10)))?.job_id).toBe(J(11));
    expect(await ref("dismissed_jobs", R(20))).toBeUndefined();
    expect((await ref("dismissed_jobs", R(21)))?.job_id).toBe(J(5));
  });

  it("applications: the move keeps confirmed_at/status/notes through the BEFORE UPDATE trigger; the dropped one leaves its status_events link null", async () => {
    const moved = (await db.query<{ job_id: string; confirmed_at: Date | null; status: string; notes: string }>(
      "select job_id, confirmed_at, status, notes from public.applications where id = $1", [R(30)],
    )).rows[0];
    expect(moved.job_id).toBe(J(2));
    expect(moved.confirmed_at).not.toBeNull();
    expect(moved.status).toBe("interview");
    expect(moved.notes).toBe("n1");
    expect(await ref("applications", R(31))).toBeUndefined();
    const ev = (await db.query<{ application_id: string | null }>("select application_id from public.status_events where id = $1", [R(35)])).rows[0];
    expect(ev.application_id).toBeNull();
  });

  it("artifacts: a collision on (user, keeper, kind) is left on the variant row, never deleted; the other moves", async () => {
    expect((await ref("artifacts", R(40)))?.job_id).toBe(J(1));
    expect((await ref("artifacts", R(41)))?.job_id).toBe(J(2));
    expect((await ref("artifacts", R(42)))?.job_id).toBe(J(2));
    expect((await db.query<{ c: number }>("select count(*)::int as c from public.artifacts")).rows[0].c).toBe(3);
  });

  it("no jobs row is deleted", async () => {
    expect((await db.query<{ c: number }>("select count(*)::int as c from public.jobs")).rows[0].c).toBe(JOBS.length);
  });

  it("lone rows: personio .com rewritten to .de (query kept); greenhouse and the root path untouched", async () => {
    expect(await job(12)).toEqual({ url: "https://accure.jobs.personio.de/job/333", is_live: true });
    expect(await job(3)).toEqual({ url: "https://flatpay.jobs.personio.de/job/222?display=en", is_live: true });
    expect(await job(13)).toEqual({ url: "https://boards.greenhouse.io/Acme/jobs/1?gh_jid=1", is_live: true });
    expect(await job(14)).toEqual({ url: "https://example.com/", is_live: true });
  });

  // Reviewer finding 1.
  it("an age-chosen keeper of a group with no canonical row gets its url rewritten; its variant retires; the refs land on it", async () => {
    expect(await job(8)).toEqual({ url: "https://apply.workable.com/beta/j/def", is_live: true });
    expect(await job(9)).toEqual({ url: "https://apply.workable.com/beta/j/def?utm=1", is_live: false });
    expect((await ref("scores", R(6)))?.job_id).toBe(J(8));
  });

  it("the next scrape's upsert of the canonical url then refreshes that keeper instead of inserting a live twin", async () => {
    // scripts/scrape.mjs: supabase.from("jobs").upsert(rows, { onConflict: "url" })
    await db.query("insert into public.jobs (url, title) values ($1, 'refreshed') on conflict (url) do update set title = excluded.title", [
      canonUrl("https://apply.workable.com/Beta/j/DEF/"),
    ]);
    const rows = (await db.query<JobRow & { title: string }>(
      "select url, is_live, title from public.jobs where lower(url) like 'https://apply.workable.com/beta/j/def%' order by url",
    )).rows;
    expect(rows.filter((r) => r.is_live)).toEqual([{ url: "https://apply.workable.com/beta/j/def", is_live: true, title: "refreshed" }]);
    expect((await db.query<{ c: number }>("select count(*)::int as c from public.jobs")).rows[0].c).toBe(JOBS.length);
  });

  // Reviewer finding 2.
  it("a double-slash straggler is rewritten to the slash-free form in ONE run", async () => {
    expect(await job(17)).toEqual({ url: "https://acme.com/careers/y", is_live: true });
  });

  it("a rerun is a no-op: every table byte-identical, every count zero", async () => {
    const before = await dump(db);
    const again = await runMigration(db);
    expect(await dump(db)).toBe(before);
    expect(again[0]).toMatch(/ 0 variant row\(s\) retired now /);
    expect(again[0]).toMatch(/ 0 keeper\(s\) chosen by age /);
    expect(again[1]).toMatch(/scores 0\/0, saved_jobs 0\/0, dismissed_jobs 0\/0, applications 0\/0; artifacts moved 0,/);
    expect(again[2]).toMatch(/^merge_url_variant_rows: 0 row\(s\) rewritten /);
  });

  it("the operator's dry run, taken before the migration, predicts every number the notices report", () => {
    expect(dryRun).toEqual({
      "groups (keys with more than one row)": 5,
      "groups skipped: no canonical row and a created_at tie": 1,
      "keepers chosen by age with no canonical-form row (url rewritten, see below)": 1,
      "variant rows to retire (is_live = false)": 5,
      "variant rows: personio .com": 1,
      "variant rows: trailing slash": 2,
      "variant rows: case / query residue": 2,
      "variant rows live today": 5,
      "keepers not live while a variant is live (not changed by the migration)": 1,
      "scores: rows on variants": 5,
      "scores: to move to the keeper": 3,
      "scores: to drop (keeper already has that user+rubric)": 2,
      "saved_jobs: rows on variants": 1,
      "saved_jobs: to move": 1,
      "saved_jobs: to drop": 0,
      "dismissed_jobs: rows on variants": 1,
      "dismissed_jobs: to move": 0,
      "dismissed_jobs: to drop": 1,
      "applications: rows on variants": 2,
      "applications: to move": 1,
      "applications: to drop (NOT reversible; status_events/inbound_emails links go null)": 1,
      "artifacts: rows on variants": 2,
      "artifacts: to move": 1,
      "artifacts: left on the variant row (would collide on user+kind)": 1,
      "rows to rewrite to the canonical url": 4,
      "rows to rewrite: personio .com": 2,
      "rows to rewrite: trailing slash": 2,
      "rows to rewrite: case / query residue": 0,
      "rows to rewrite: age-chosen keepers of a group with no canonical row": 1,
    });
  });

  it("the operator's capture lists every retired variant with its keeper and every url rewrite with its target", () => {
    const byKind = (kind: string) => capture.filter((r) => r.kind === kind);
    expect(byKind("variant").map((r) => [r.id, r.ref, r.was_live]).sort()).toEqual([
      [J(1), J(2), true], [J(6), J(5), true], [J(7), J(5), true], [J(9), J(8), true], [J(10), J(11), true],
    ].sort());
    expect(byKind("single").map((r) => [r.id, r.old_value, r.ref]).sort()).toEqual([
      [J(3), "https://flatpay.jobs.personio.com/job/222?display=en", "https://flatpay.jobs.personio.de/job/222?display=en"],
      [J(8), "https://apply.workable.com/Beta/j/DEF/", "https://apply.workable.com/beta/j/def"],
      [J(12), "https://accure.jobs.personio.com/job/333", "https://accure.jobs.personio.de/job/333"],
      [J(17), "https://acme.com/careers/y//", "https://acme.com/careers/y"],
    ].sort());
    expect(byKind("scores").map((r) => r.id).sort()).toEqual([R(1), R(3), R(4), R(5), R(6)].sort());
    expect(byKind("saved_jobs").map((r) => r.id)).toEqual([R(10)]);
    expect(byKind("dismissed_jobs").map((r) => r.id)).toEqual([R(20)]);
    expect(byKind("applications").map((r) => r.id).sort()).toEqual([R(30), R(31)].sort());
    expect(byKind("artifacts").map((r) => r.id).sort()).toEqual([R(40), R(42)].sort());
  });
});

describe("merge_url_variant_rows: the SQL key mirrors scripts/canon-url.mjs", () => {
  let db: PGlite;
  const KEY = keyExpression(MIGRATION);

  beforeAll(async () => {
    db = new PGlite();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("the dry run and the capture carry the migration's key expression byte for byte", () => {
    expect(keyExpression(DRY_RUN)).toBe(KEY);
    expect(keyExpression(CAPTURE)).toBe(KEY);
  });

  // Inputs as jobs.url holds them: every row went through `new URL(...).toString()`
  // at scrape time, so scheme and host are lowercase and the path is present.
  const CORPUS = [
    "https://jobs.lever.co/Perk/AbC-123?lever-source=LinkedIn#apply",
    "https://jobs.ashbyhq.com/TravelPerk/9F1E?utm_source=x",
    "https://apply.workable.com/Acme/j/ABCDEF1234/?utm_medium=y",
    "https://jobs.smartrecruiters.com/Acme/743999?trid=1",
    "https://acme.breezy.hr/p/ABC123-product-manager?source=li",
    "https://boards.greenhouse.io/Acme/jobs/4012345?gh_jid=4012345",
    "https://vytal.jobs.personio.com/job/1234567",
    "https://vytal.jobs.personio.com/job/1234567?language=en",
    "https://vytal.jobs.personio.de/job/1234567",
    "https://nordsecurity.com/careers/8b1c2d3e-0000-4000-8000-000000000000/",
    "https://example.com/jobs/42/?ref=startupmap",
    "https://example.com/jobs/42/#apply",
    "https://acme.com/careers/y//",
    "https://acme.com/careers/y///?next=/b/",
    "https://example.com//",
    "https://example.com//?x=1",
    "https://example.com/",
    "https://example.com/?x=1",
    "https://EXAMPLE.com/Path/",
  ].map((u) => new URL(u).toString());

  it.each(CORPUS)("%s", async (url) => {
    const { rows } = await db.query<{ canon: string }>(`select ${KEY} as canon from (select $1::text as url) j`, [url]);
    expect(rows[0].canon).toBe(canonUrl(url));
  });

  it("is a fixpoint, so a row already holding a canonical url always sits in its own group (the step-5 guard cannot fire)", async () => {
    for (const url of CORPUS) {
      const once = (await db.query<{ canon: string }>(`select ${KEY} as canon from (select $1::text as url) j`, [url])).rows[0].canon;
      const twice = (await db.query<{ canon: string }>(`select ${KEY} as canon from (select $1::text as url) j`, [once])).rows[0].canon;
      expect(twice, url).toBe(once);
    }
  });
});

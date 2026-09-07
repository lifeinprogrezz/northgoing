# Architecture

How Northgoing is built, for a developer (human or agent) landing in this repo for the
first time. Written 2026-07-25 (issue #60). Companion docs: [`DATA_CONTRACT.md`](./DATA_CONTRACT.md)
for the job-row schema, [`scoring-benchmarks.md`](./scoring-benchmarks.md) for scorer calibration.

## What the product does

It finds European tech roles, scores each one against *your* CV with a language model, and
prepares the application. The user-facing shape is a globe: roles clustered by city, ranked
by fit once a CV is on file.

**Product roles are the opening wedge, not the scope.** The ingestion and scoring path is
still product-only today — `scorePrompt.ts` hard-wires the discipline and `job-filters.mjs`
gates the pool — but the database and the interface are already vertical-agnostic:
`jobs.role_family` exists, and the headbar Role facet renders whatever families the rows
carry. Widening the engine is issue #34; nothing above it needs reshaping.

Three surfaces, all behind sign-in except the map:

- `/` — the globe. Anonymous visitors browse the whole live catalog; signed-in users with a
  CV get a fit-ranked "Best fit" rail.
- `/today` — the daily action queue: saved roles, a numbered top ten to apply to, then the
  rest of the matches.
- `/apply` and `/tracker` — the application bundle (tailored CV, cover letter, form-question
  answers) and a kanban of what you've sent.

## The shape of the system

```
 GitHub Actions (cron)          Vercel                    Supabase
 ─────────────────────          ──────                    ────────
 scrape.yml      03:47 UTC* →   api/nightly.ts        →   Postgres  (jobs, companies,
 nightly.yml     */10 6-9   →   api/score-backlog.ts  →              profiles, scores,
 score-backlog   */10 all day                                        daily_matches, …)
 spend-alert     10:00 UTC  →   api/spend-alert.ts    →              usage_events (read)
 deploy-edge-fns on push    →   the React SPA         →   anthropic-proxy (edge function)
                                                      →   Storage (dataplane artifacts)
 * started by pg_cron through api/scrape-dispatch.ts, not by GitHub's own schedule (2026-09-07)
```

Nothing here is a long-running server. Every moving part is either a scheduled job, a
serverless function with a 60-second ceiling, or the browser.

### Why the schedulers live in GitHub Actions

Vercel Hobby crons fire **once a day**. The scoring backlog and the nightly matcher both
need to run repeatedly to drain work within a serverless time budget, so GitHub Actions owns
the *trigger* (`curl` with `CRON_SECRET`) while the *work* stays in `api/` on Vercel. Read
the header comments in `.github/workflows/nightly.yml` and `score-backlog.yml` before
changing either — the split is deliberate, not accidental.

## The data plane

### Ingestion — `scripts/scrape.mjs`

Runs daily at 05:00 UTC. Reads `scripts/boards.json` (verified Greenhouse / Lever / Ashby /
Workable / SmartRecruiters / Teamtailor / Personio / Recruitee / Join tokens) and the modules
in `scripts/sources/`:

- `ats-extra.mjs` — SmartRecruiters, Workable, Workday, Factorial
- `teamtailor.mjs` — Teamtailor's official `{site}/jobs.json` syndication feed. One request
  per company, full description inline, no auth. Boards come in two flavours: `token` for a
  `*.teamtailor.com` subdomain, `host` for a custom career domain (`careers.macadam.app`),
  which is how most of the European tenants publish
- `personio.mjs` — Personio's public per-tenant `/xml` feed
  (`{token}.jobs.personio.de/xml`; the `.com` mirror serves the same document). One request
  per company, full description inline, no auth. Personio emits bare city names with no
  country, so the connector translates the European hub cities (native spellings included)
  into the shared filter's vocabulary
- `recruitee.mjs` — Recruitee's public per-tenant `/api/offers/` document
  (`{token}.recruitee.com/api/offers/`, or `{host}/api/offers/` on a custom career domain).
  One request per company, no auth, no pagination, and both bodies (`description` plus
  `requirements`) inline. Offers filed under a "Portfolio Company" department are DROPPED:
  a venture talent board carries other companies' roles while reporting its own name in
  every field, so there is nothing to re-attribute to (issue #68's Getro class)
- `joincom.mjs` — Join.com's public candidate GraphQL. Entries carry `token` (the company
  slug) and `companyId`, and a seeded id skips the slug lookup, so it is one request per
  company. Skews to the German-speaking small-company long tail
- `bigtech.mjs` — Google, Amazon, Microsoft, Apple (Meta is a documented known gap: its
  endpoint rejects datacenter and budget-residential IPs; only a premium proxy pool would
  change that, so the scraper skips it gracefully)
- `vc-startupmap.mjs` — venture portfolio boards plus startupmap.one
- `_proxy.mjs` — routes *only* the sources that need a residential exit through
  `SCRAPE_PROXY_URL`; everything else goes direct, keeping proxy bandwidth to a few hundred
  kilobytes a day

### Keeping the board list current — `scripts/sync-boards.mjs`

The personal career-ops engine resolves postings back to their applicant-tracking system
every night, so it learns about new company boards before the product does. This script
reads that engine's files (read only), pulls out every board token it has ever seen, drops
what `boards.json` already knows, verifies each remaining board against its public endpoint,
and with `--write` adds the live ones. It is idempotent, so a monthly
`node scripts/sync-boards.mjs --engine=<career-ops-dir> --write` is safe. Without it the
board list quietly falls behind and the diff gets done by hand again.

Rows are filtered by `job-filters.mjs`, enriched (`enrich-companies.mjs`,
`enrich-uk-sponsors.mjs`, `extract-jd.mjs`, `workplace-lib.mjs`) and upserted. **Rows missing
`company`, `title`, or `url` are dropped before the upsert with a logged count** — one null
company once failed an entire run, so the filter and its log line are load-bearing.

### Company records, logos, offices (issue #153)

Three steps close the gap between "a name on a job listing" and a real map pin, in this order
(after the enrichment above, before the dataplane publish):

- **`scripts/company-records.mjs`** — a `companies` row for every distinct company on live jobs
  that lacks one. Name = the most common exact spelling seen today (`groupByCompanyName`,
  `company-records-lib.mjs`), the SAME key `public.link_jobs_to_companies()` matches on, so the
  new row is linked to its jobs in the same run. Slug via `slugForCompany()`, matching the
  underscore convention already live in the table. Bounded 400 rows/run, idempotent (upsert,
  `ignoreDuplicates`).
- **`scripts/logo-backfill.mjs`** — unchanged for companies with a `careers_url`/`website`
  already on file; extended so a company with NEITHER (the job-derived rows above) falls to the
  host of its own apply URL (`resolveLogoDomain`, `logo-lib.mjs`) — never a hosted-ATS/platform
  host, so a resolved domain is always the company's own site. Client-side, `src/lib/logodev.ts`
  never guesses a domain from the name: a company with no domain on file renders the coloured
  initial (a speculative favicon request 404s and the browser logs every failed image load to
  the console, which no `onError` handler can silence).
- **`scripts/geocode-companies.mjs`** — real street coordinates per company × city. Two Nominatim
  queries per candidate: the company + its job location, then the resolved city name alone (a
  query hundreds of other companies in the same city share, so it is almost always a free cache
  hit after the first). Within 50km of each other → `company_offices`; else nothing. Cached
  forever in `geocode_cache` (migration `20260827110000`), rate-limited to 1 req/s, bounded
  200 network calls/run — a repeat run never re-asks a question it already has the answer to, and
  the gap closes over days. Mapbox instead of Nominatim when `MAPBOX_TOKEN`/`MAPBOX_ACCESS_TOKEN`
  is set. Degrades gracefully (skips caching only) if the migration is not applied yet.

A company still without a resolved office keeps the client's centroid disc
(`src/hooks/useRolesData.ts` `centroidPlace`) — widened per city by `discRadiusFor(n)` so a dense
city (30+ office-less companies) fans pins out instead of stacking them at a fixed radius.

### Publication — `scripts/build-dataplane.mjs`

After each scrape, the catalog is written to a public Storage bucket as `dataplane.json` and
`jobs.ndjson`. The map fetches the artifact first and falls back to a live read, so an
anonymous visit to `/` is **one storage GET and zero database reads**.

**A new column in `JOBS_COLUMNS` needs an artifact rebuild, in the same pass.** The column
sets live in `scripts/dataplane-lib.mjs`; the artifact is a snapshot of them, so between
adding a column and the next scrape the client is reading rows that predate it. That gap
cost a day: `jobs.has_jd` was added on 2026-08-26, the artifact in front of users had been
built at 05:00, and the map counted 367 roles left to score while the worker bought 236
(issue #149, item A8). Run `npm run dataplane:build` (service-role env, same contract as
the scrape) right after the migration. `src/lib/dataplane.ts` also enforces this at runtime:
`fetchDataplane` refuses an artifact whose jobs lack `has_jd`, and the app falls back to the
live reads, which select it. The refusal is a cost regression, never a broken map. It sits in
`fetchDataplane`, not in `isDataplane`, because the GEO prerender in `vite.config.ts` shares
that structural guard and never reads the column.

### Scoring — two paths, one prompt

`src/lib/scorePrompt.ts` holds the rubric and its `RUBRIC_VERSION`. Both callers share it:

- **`api/score-backlog.ts`** (every 10 minutes) scores every CV-holding user's unscored live
  roles at the current rubric version, concurrency 8, inside a 45-second budget, upserting as
  results land. The backlog predicate is simply "a live job with no `scores` row at the
  current rubric" — a new CV, a changed CV, and a rubric bump all express themselves as
  backlog, so there is no queue table to keep consistent.
- **`api/score-kick.ts`** (on demand) runs that same drain for ONE user, the moment they save
  a CV or new targets (issue #149). The schedule above is declared every 10 minutes and
  throttled by GitHub to roughly hourly, so a new user used to wait an hour for a first
  score. The drain itself is `runBacklog`, exported from the worker and shared by both paths.
  The cron path keeps its `CRON_SECRET`; the kick never sees it and instead verifies the
  caller's own Supabase access token server-side, then drains for that user id only. POST
  only, one kick per user per two minutes.
- **`api/nightly.ts`** (mornings) picks each active user's fresh labelled slice, ranks it, and
  sends one email through Resend.

The client does **not** score. `useRolesData.ts` polls the `scores` table every 20 seconds
while unscored roles remain. One scoring path means no double-spend and no work lost when a
tab closes.

**No description, no score (issue #130).** A role whose `jd_text` is null or blank is never
sent to the scorer, by any path: the per-user prefilter (`src/lib/scorePrefilter.ts`
`hasReadableJd`, applied inside `prefilterWithTier` before the caps), the nightly candidate
list, and the interactive `scoreJob`. The backlog worker and the dataplane artifact do not
fetch the multi-KB body, so they read the generated column `jobs.has_jd` instead; `jd_text`
wins when a caller has it. Measured on production (12,623 scores): JD-less roles scored
>= 4.0 at 6.0% versus 1.8% for roles with a JD, because an empty JD holds nothing that can
disqualify a CV. 3,934 of those 12,623 scores were bought for JD-less roles, so the rule
removes about 31% of score purchases. Scores already stored for JD-less roles are kept but
not applied at display time (`applyLandedScores`, the initial merge in `useRolesData.ts`):
the role renders as "No description yet" and cannot rank on a stale score. The client
prefilter shares the predicate, so "still scoring" and "what gets paid for" keep agreeing.

**A cached score is forever** — the null-score filter never revisits a row. So never write a
degraded score: scoring is gated on `cv_text` being present, and a failed job-description
fetch must not produce a description-blind score.

### The language-model chokepoint

Every call goes through the `anthropic-proxy` edge function. Nothing calls Anthropic
directly, and the browser never holds the key. The proxy enforces a model allowlist, a `kind`
allowlist (`score`, `audit`, `cv`, `letter`, `answer`), and a `max_tokens` ceiling, then
records tokens, cost, and latency to `usage_events` server-side.

Spend caps were **deliberately removed** pre-launch; `usage_events` is the observability
surface a future cap will read. That is a settled decision, not an oversight (issue #35).

**When you add a request header, add it to the proxy's CORS allowlist in the same commit.** A
missing `x-region` entry once passed preflight and silently blocked every POST, killing CV
generation in browsers.

### The schedule lives in the database, not in GitHub Actions

GitHub Actions cron is best effort. On 2026-08-27 not one scheduled run fired
between 03:00 and 11:00 UTC (no 05:00 scrape, no 06:00-09:50 nightly window, one
backlog tick all morning) while GitHub reported no incident, and every manual
trigger of the same workflows ran green. The workers were fine; the scheduler was
not.

The three HTTP workers are therefore scheduled by `pg_cron` inside Supabase
(migration `20260827170000_pg_cron_scheduler.sql`): `northgoing-nightly` every ten
minutes across 06:00-09:50 UTC, `northgoing-score-backlog` every ten minutes, and
`northgoing-spend-alert` at 10:00 UTC. Each job calls `public.tick_worker(name)`,
which reads the cron secret from Supabase Vault (secret name `cron_secret_db`,
falling back to `cron_secret`) and posts to `https://northgoing.com/api/<name>`
with it. That secret is the database's OWN: Vercel env vars of type Secret are
write-only, so the existing `CRON_SECRET` cannot be copied into Vault, and
rotating it would take Vercel, the GitHub repo secret and Vault down together.
The endpoints accept either secret (`cronAuthResult` takes a list), so the GitHub
workflows keep running on the untouched `CRON_SECRET` while the database uses
`CRON_SECRET_DB`. While that Vault secret is
absent the function does nothing at all, so the schedule is safe to install before
the secret exists.

The GitHub workflows stay as a second belt. Both callers are idempotent (the shared
scores ledger, issue #135), so a doubled tick costs one read, never a double
purchase.

The scrape is the exception: it runs ON a runner (ten Node steps, minutes of
runtime), so it cannot sit behind an endpoint. Until 2026-09-07 it kept GitHub's
own `schedule:` and got a watchdog instead (`northgoing-scrape-watchdog`, 05:15
UTC, `api/scrape-watchdog.ts`). Then seven mornings in a row (9-01 to 9-07) the
03:47 schedule fired between 07:52 and 08:55 UTC: the watchdog restarted the
scrape every day, the digest was served from the restart, and GitHub's late run
scraped the pool a second time. So pg_cron now starts the scrape too:
`northgoing-scrape-dispatch` calls `tick_worker('scrape-dispatch')` at 03:47 UTC
(migration `20260907190000_scrape_dispatch_pg_cron.sql`), and
`api/scrape-dispatch.ts` asks GitHub for a `workflow_dispatch` of `scrape.yml` on
`main` with `reason=scheduled`. `scrape.yml` has no `schedule:` block any more;
the watchdog is unchanged and stays the guard for a morning the dispatch never
reaches GitHub. The shared GitHub call is `src/lib/githubDispatch.ts`. The
run-name tells the three starts apart: `Scrape jobs (scheduled)`, `Scrape jobs
(watchdog restart)`, and plain `Scrape jobs` for a hand-started run.

To rotate the database's secret: set a new value in Vercel (`CRON_SECRET_DB`) and
the same value in Vault (`cron_secret_db`); nothing in the repo changes.

## The spend alert — signal, not a cap

`api/spend-alert.ts` runs once a day (`.github/workflows/spend-alert.yml`, 10:00 UTC, after
the morning drain window). It calls the `spend_alert_snapshot()` RPC, which sums
`usage_events` in the database: yesterday's total, month to date, the seven zero-filled
daily totals before yesterday, and yesterday's per-user totals. `src/lib/spendAlert.ts`
decides: alert when yesterday is more than **3x the trailing-7-day median**, or when one
user is more than **10x the median user's day** (a $1 floor keeps a fresh deployment from
paging over cents). On alert it emails `OWNER_ALERT_EMAIL` (default
`hello@lifeinprogrezz.com`) through Resend from the nightly's sender; on no alert it returns
the numbers as JSON, and it logs them either way. Its job is to make a cost step function
(a `RUBRIC_VERSION` bump, a catalogue expansion) visible within hours instead of at the
invoice. It enforces nothing; the no-cap decision above still stands. Change the thresholds
only alongside `spendAlert.test.ts`.

### Errors from functions go to Sentry

The four functions under `api/` report to the same Sentry project as the client
(`src/lib/apiSentry.ts`, issue #145). The Vercel runtime-log API stopped answering on the
Hobby plan, so console output alone is not durable. `withSentry` wraps each handler: a
thrown error is captured with a `function` tag and rethrown (the platform still answers
500); the explicit failure lines (`nightlyRunVerdict` non-ok, `[score-backlog]` upsert
failures, Resend non-ok responses) are sent as error-level messages; the per-run summary
is attached as a `run` context. Only ids and counts leave: `scrubContent` drops CV text,
job descriptions, mail subjects and bodies, and email addresses, on top of the credential
rule shared with the client. Reads `SENTRY_DSN`, falling back to `VITE_SENTRY_DSN`; with
neither set every call is a no-op. Change it only alongside `apiSentry.test.ts`.

## The front end

Vite plus React plus TypeScript, single-page, no framework router beyond `react-router`.

- **Every non-landing route is lazily loaded.** Eager application JavaScript is about 99 kB;
  maplibre (~1 MB), pdfmake, and the PDF text extractor are separate chunks that load on
  first use. Check `manualChunks` in `vite.config.ts` before adding a heavy dependency.
- **`src/components/roles/GlobeMap.tsx`** owns the map. It renders on `requestAnimationFrame`,
  which Chrome suspends in background tabs — a hidden tab will show a blank canvas and never
  fire `load`. That is browser behavior, not a bug; **verify `document.visibilityState`
  before diagnosing any map timing problem.** A real foreground cold load settles in under
  four seconds.
- **`src/lib/` is where logic lives, and it is where the tests point.** Components stay thin;
  anything worth pinning gets extracted (`roles.ts`, `nightly.ts`, `scoreBacklog.ts`,
  `tracker.ts`, `labels.ts`, `tailor.ts`, `cvStructured.ts`, `cvParse.ts`, `pdf.ts`).

### Two trust rules that are not negotiable

1. **The CV body is the user's own words, never the model's.** A CV is parsed ONCE, at
   upload, from `cv_text` into `cv_structured` (`cvStructured.ts`, stored by `cvParse.ts`).
   `validateCvStructured` refuses any bullet or date that is not a verbatim substring of
   `cv_text`: an ungrounded line is dropped, never stored. The owner corrects the result in
   Settings (`CvEditor.tsx`), `buildStructuredCvDoc` (`pdf.ts`) renders it deterministically,
   and a profile with no structure falls back to the verbatim `cv_text` render. The only
   generated text is the tailored summary — one language model call per role, not per CV.
   Never invent, reword, or drop a line of someone's CV.

   Two guards keep that honest and affordable, both pinned by `cvParse.test.ts`: a structure
   stamped BEFORE `cv_changed_at` belongs to a previous CV and is thrown away rather than
   printed, and a parse that already ran is never bought again on the next page load.
2. **Generated PDFs carry a real text layer** (pdfmake, never a rasterized page image), or
   applicant tracking systems cannot parse them and the feature is worse than useless.

Both are pinned by tests. Change either only alongside its test.

## Database conventions

Migrations are plain SQL in `supabase/migrations/`, timestamp-prefixed (39 today).

- **The timestamp must be unique.** Two sessions once stamped the same minute and collided;
  CI now has an ephemeral-database check that catches duplicate versions.
- **Apply through the Supabase MCP `apply_migration`, then mirror the file into the repo** so
  the repository stays the canonical record.
- **The project reference of record is `VITE_SUPABASE_URL` in the frontend `.env`**, not
  `config.toml` — a stale reference in `config.toml` once mis-aimed tooling at a dead project.
- **The migration set must reproduce production, and CI proves it** (issue #132).
  `supabase/schema-snapshot.json` is production's public schema — tables, columns,
  constraints, indexes, policies, functions (signature, `SECURITY DEFINER`, `search_path`,
  and a hash of the body with comments, whitespace and letter case removed), triggers and
  views — as returned by `public.schema_snapshot()`. Two CI jobs compare against it:
  `migrations-rls` builds a database from `supabase/migrations/` and diffs it (a `+` line is
  an object only production has: write a migration; a `-` line is a migration never
  applied there), and `schema-drift-prod` reads production through the service role.
  Grants are not in the snapshot: the hosted stack and the local one differ in their
  default privileges. After a schema change lands in both places, refresh the file with
  `npm run schema:drift -- --write` (needs `DATABASE_URL` plus `psql`, or `SUPABASE_URL`
  plus `SUPABASE_SERVICE_ROLE_KEY`) and commit it in the same change. `npm run schema:drift`
  alone runs the comparison. Compare logic: `scripts/schema-drift-lib.mjs`, pinned by
  `src/test/schema-drift-lib.test.ts`.

Row-level security is the enforcement layer; client-side checks are decoration. Per-user
tables expose own-row policies only. `usage_events` is **not** client-writable — the proxy
writes it with the service role — because a client-writable meter with no non-negative
constraint is a spend-cap bypass. Wrap `auth.uid()` as `(select auth.uid())` in policies so
Postgres hoists it out of the row loop.

## Environment

Client (`VITE_`-prefixed, baked into the bundle, all public by design):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_LOGODEV_TOKEN`,
`VITE_SENTRY_DSN`, `VITE_POSTHOG_KEY`, `VITE_E2E_BYPASS_AUTH`.

Server (Vercel environment and GitHub secrets, never in the bundle):
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
`CRON_SECRET`, `SCRAPE_PROXY_URL`, `OWNER_ALERT_EMAIL` (optional; the spend alert's
recipient, defaults to `hello@lifeinprogrezz.com`), `SENTRY_DSN` (the functions' Sentry
DSN; falls back to `VITE_SENTRY_DSN`).

`SUPABASE_SERVICE_ROLE_KEY` must be the legacy `eyJ…` service-role JWT. Note that the
dashboard's service-role token and the one an edge function receives are *different but both
valid* JWTs, so never compare them by string equality — validate the decoded `role` claim
after the gateway has verified the signature.

## Deploying

Two stages, no preview environments:

- **`localhost:8080`** — `npm run dev`. It talks to the *production* Supabase, so saving a
  role or marking one applied writes real rows.
- **`main` → northgoing.com** — pushing to `main` deploys the frontend on Vercel, and any commit
  touching `supabase/functions/**` deploys the edge function through
  `deploy-edge-functions.yml`. One push ships both. The old `auditjob.me` still resolves
  and 308-redirects to `northgoing.com` (`vercel.json`), except under `/api`, which both
  hosts continue to serve.

### The origin contract (nothing in code enforces this)

Sign-in is origin-bound and the binding lives in the Supabase dashboard, not this repo.
`AuthProvider` and `CvUnlockModal` pass `redirectTo: window.location.origin`, and GoTrue
does **not** error on an origin missing from its Redirect-URLs allowlist. It silently
substitutes the Site URL, so the OAuth fragment lands on a different origin than the one
the user started on. That is not a failed login, which would be obvious. It is a login
that succeeds on the wrong host, where the pre-redirect CV stash written to
`auditjobme.cvStash` cannot be read, so the user is asked to paste the CV they just pasted.

Two rules follow, and they are the reason this section exists:

1. **Exactly one origin serves users: `https://northgoing.com`.** Every other host that
   resolves must 308 to it before any JavaScript runs, `www` included. `vercel.json` does
   this for `www.northgoing.com`, `auditjob.me`, `www.auditjob.me` and the `*.vercel.app`
   aliases. A newly attached domain is a new origin and needs a rule in the same commit.
2. **The Supabase allowlist must contain that origin with a path wildcard**
   (`https://northgoing.com/**`). The bare origin is not enough: auth returns to the path
   the user was on, so `/today`, `/apply` and `/tracker` deep-returns need the wildcard.

Verifying it needs no credentials, and the control is what makes the check real: request
`/auth/v1/verify?token=bogus&type=signup&redirect_to=<url>` and read the `Location`. An
allowlisted URL comes back verbatim; a rejected one comes back as the Site URL. Test a
deliberately bogus domain alongside, or a permissive allowlist looks identical to a
correct one.

Branch preview deployments are disabled in `vercel.json` (`git.deploymentEnabled`). They
caused two stale-build reviews and reviewed nothing.

`vite dev` does **not** run `api/*` or the edge function. Anything touching those gets checked
on production right after deploy — five bugs in the nightly pipeline were runtime-only and
invisible to green tests and four reviewers.

## Local setup

```bash
npm ci
cp .env.example .env     # fill in the VITE_ values
npm run dev              # http://localhost:8080
```

Requires Node 24, which is what continuous integration runs.

## Testing

```bash
npm run typecheck   # tsc -p tsconfig.app.json && tsc -p api/tsconfig.json
npm run lint
npm run test        # vitest, ~358 tests across 33 files
npm run build
```

**Run `npm run typecheck`, never a bare `tsc --noEmit`.** The root config is loose; the two
project configs above are what continuous integration enforces. Bare `tsc` has passed clean
on code that CI rejected.

`scripts/verify-smoke.mjs` walks the canonical path against a running build, including an
authenticated pass. It is the closest thing to an end-to-end test and it is not part of the
offline gate — run it deliberately.

The gate in `.github/workflows/ci.yml` is lint, typecheck, test, and build, all blocking,
plus a secrets scan and the migration and row-level-security check.

### Email: sending and receiving moved separately

The nightly digest and the scores-ready mail send from `matches@northgoing.com`
(verified in Resend 2026-08-19: DKIM plus SPF live on `send.northgoing.com`, region
eu-west-1). Replies do not go there. `northgoing.com` has **no apex MX record**, so any
address at the bare domain bounces, and the `List-Unsubscribe` mailto therefore still
points at `hello@lifeinprogrezz.com`, which is a real Google-hosted mailbox. Moving it
needs apex MX first, not just a verified sending domain. A bounced unsubscribe is worse
than an off-brand one.

**Receiving** is a separate pipeline, per user. `inbound_tokens` gives each user a
personal `u-{token}@northgoing.com`; one guided Gmail filter forwards their applicant-
tracking-system mail there, and `api/inbound-email.ts` (service role, authenticated by
Svix for Resend or a shared bearer secret for anything else) classifies what arrives
and advances the matching `applications` row through the same `status_events` trigger
a manual kanban move uses. The pure logic — token parsing, the ATS sender map, the
classifier, the stale-guarded transition — lives in `src/lib/inbound.ts`, pinned by
`src/test/inbound.test.ts`.

Gmail's own forwarding setup needs a confirmation, and that confirmation mail lands at
the forwarding address itself rather than in the user's inbox. The endpoint stores the
link it extracts on the token row, then follows it server-side (issue #157 / LOCKED
decision 7) and stamps `inbound_tokens.gmail_confirmed_at` on success, so Settings
shows "Confirmed" without the user clicking anything. The same mail carries a cancel
link one letter away (`/mail/uf-...`, next to the confirm link's `/mail/vf-...`);
`isConfirmUrl` checks the host and path again right before that one fetch, so the
endpoint can never follow it. Any failure — a timeout, a non-200, a body that reads
like Gmail rejected the link — leaves the column null, and the manual "Confirm
forwarding in Gmail" button in `ForwardingSection.tsx` stays the fallback, which is
also what happens in an environment where the migration hasn't landed yet (the update
is caught, not thrown).

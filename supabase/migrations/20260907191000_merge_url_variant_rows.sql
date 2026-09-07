-- One-time merge of url-variant duplicate rows in public.jobs (2026-09-07).
--
-- jobs.url is UNIQUE, so two spellings of one posting are two rows: each is
-- scored again per user (965 scores rows sat on a duplicate on 2026-09-07) and
-- the role shows twice. Three classes were measured, whole pool:
--   personio       `X.jobs.personio.com` vs `.de`   285 groups (still produced daily:
--                  sources/personio.mjs emits .de, startupmap emits .com)
--   trailing slash `/careers/<uuid>/` vs no slash    9 groups (nordsecurity via startupmap)
--   case residue   workable / ashby / smartrecruiters ~77 groups (the scraper has
--                  lowercased these paths since 2026-07-06; the rows never merged)
-- scripts/canon-url.mjs now stops all three at ingest. This file folds what is
-- already in the table. The normalized key below MIRRORS canon-url.mjs rule for
-- rule; change them together.
--
-- What happens, in one transaction (a DO block is one statement; the CLI and the
-- MCP wrap the file in a transaction as well):
--   1. key every row: lowercase scheme+host (new URL does that on every url),
--      personio .com -> .de, then on lever/ashby/workable/smartrecruiters/breezy
--      drop the query+fragment and lowercase the path (greenhouse keeps both:
--      embedded boards need ?gh_jid= and its paths are case-sensitive), then strip
--      one trailing slash from a path longer than "/".
--   2. groups = keys with more than one row. Keeper = the row whose url already IS
--      the canonical form (the next scrape refreshes it through the url upsert),
--      else the oldest created_at. Guard: a group with no canonical row and a tie
--      on the oldest created_at is skipped and reported, never guessed.
--   3. for every other row (the variant): move scores / saved_jobs /
--      dismissed_jobs / applications to the keeper. Each is unique on
--      (user_id, job_id[, rubric_version]); where the keeper already has the row,
--      the keeper's wins and the variant's is deleted. Moved rows keep their id.
--      artifacts.job_id is re-pointed the same way, but an artifact that would
--      collide on (user_id, job_id, kind) is LEFT on the variant row: it is user
--      content (a CV, a letter), and the variant row still exists.
--   4. the variant is set is_live = false. NO jobs row is deleted: the FK cascades
--      on scores/saved/dismissed/applications would wipe user data, and a retired
--      row can be flipped back.
--   5. a row that is alone under its key but is not spelled canonically (a
--      startupmap .com personio url with no .de twin yet, a lone trailing slash)
--      gets its url rewritten to the canonical form. Without this the very first
--      scrape after canon-url.mjs ships would insert the canonical twin next to
--      it, and the old row would never retire: scrape.mjs only retires rows of
--      board sources, and the liveness sweep sees a live mirror. Guarded against
--      any existing row already holding the target url.
-- Rerunning is a no-op: retired variants with no refs move nothing, rewritten
-- singles equal their key. Counts are raised as notices per class.
--
-- daily_matches is keyed by job_url and is a historical ledger: untouched.
-- The schema does not change, so supabase/schema-snapshot.json stays as is.

do $$
declare
  v_groups          integer;
  v_skipped         integer;
  v_no_canonical    integer;
  v_variants        integer;
  v_personio        integer;
  v_slash           integer;
  v_case            integer;
  v_scores_moved    integer;
  v_scores_dropped  integer;
  v_saved_moved     integer;
  v_saved_dropped   integer;
  v_dism_moved      integer;
  v_dism_dropped    integer;
  v_apps_moved      integer;
  v_apps_dropped    integer;
  v_art_moved       integer;
  v_art_left        integer;
  v_retired         integer;
  v_singles         integer;
  v_singles_personio integer;
  v_singles_slash   integer;
  v_singles_case    integer;
begin
  -- 1. normalized key per row. Keep this expression identical to the dry-run
  --    SELECT in the PR that shipped this file and to scripts/canon-url.mjs.
  create temporary table merge_keyed on commit drop as
  select
    j.id,
    j.url,
    j.created_at,
    j.is_live,
    coalesce(
      (
        with parts as (
          select
            regexp_replace(lower(substring(j.url from '^(https?://[^/?#]+)')), '\.jobs\.personio\.com$', '.jobs.personio.de') as sh,
            coalesce(nullif(substring(j.url from '^https?://[^/?#]+(.*)$'), ''), '/') as rest
        ),
        stripped as (
          select
            sh,
            case
              when substring(sh from '^https?://(.*)$') ~ '(^|\.)(lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|breezy\.hr)$'
                then lower(regexp_replace(rest, '[?#].*$', ''))
              else rest
            end as rest
          from parts
        )
        select sh || regexp_replace(rest, '^(/[^?#]+?)/((?:[?#].*)?)$', '\1\2') from stripped
      ),
      j.url
    ) as canon
  from public.jobs j;
  create index on merge_keyed (canon);

  -- 2. groups and their keeper.
  create temporary table merge_groups on commit drop as
  select
    canon,
    count(*)::integer as n,
    (array_agg(id order by (url = canon) desc, created_at asc, id asc))[1] as keeper_id,
    bool_or(url = canon) as has_canonical,
    (array_agg(created_at order by created_at asc))[1] = (array_agg(created_at order by created_at asc))[2] as oldest_tie
  from merge_keyed
  group by canon
  having count(*) > 1;

  select count(*) into v_groups from merge_groups;
  select count(*) into v_skipped from merge_groups where not has_canonical and oldest_tie;
  select count(*) into v_no_canonical from merge_groups where not has_canonical and not oldest_tie;

  create temporary table merge_variants on commit drop as
  select
    k.id as variant_id,
    g.keeper_id,
    k.url,
    k.is_live,
    case
      when lower(substring(k.url from '^https?://([^/?#]+)')) ~ '\.jobs\.personio\.com$' then 'personio'
      when substring(k.url from '^https?://[^/?#]+(/[^?#]*)') ~ '^/.+/$' then 'trailing-slash'
      else 'case'
    end as class
  from merge_keyed k
  join merge_groups g on g.canon = k.canon
  where k.id <> g.keeper_id
    and not (g.has_canonical = false and g.oldest_tie);

  select count(*) into v_variants from merge_variants;
  select count(*) into v_personio from merge_variants where class = 'personio';
  select count(*) into v_slash from merge_variants where class = 'trailing-slash';
  select count(*) into v_case from merge_variants where class = 'case';

  -- 3. move the refs. One candidate per unique key (distinct on), so a group of
  --    three rows cannot move two variants onto the same keeper slot.
  with pick as (
    select distinct on (s.user_id, v.keeper_id, s.rubric_version) s.id
    from public.scores s
    join merge_variants v on v.variant_id = s.job_id
    where not exists (
      select 1 from public.scores k
      where k.user_id = s.user_id and k.job_id = v.keeper_id and k.rubric_version = s.rubric_version
    )
    order by s.user_id, v.keeper_id, s.rubric_version, s.scored_at desc
  )
  update public.scores s set job_id = v.keeper_id
  from pick, merge_variants v
  where s.id = pick.id and v.variant_id = s.job_id;
  get diagnostics v_scores_moved = row_count;
  delete from public.scores s using merge_variants v where s.job_id = v.variant_id;
  get diagnostics v_scores_dropped = row_count;

  with pick as (
    select distinct on (s.user_id, v.keeper_id) s.id
    from public.saved_jobs s
    join merge_variants v on v.variant_id = s.job_id
    where not exists (
      select 1 from public.saved_jobs k where k.user_id = s.user_id and k.job_id = v.keeper_id
    )
    order by s.user_id, v.keeper_id, s.saved_at desc
  )
  update public.saved_jobs s set job_id = v.keeper_id
  from pick, merge_variants v
  where s.id = pick.id and v.variant_id = s.job_id;
  get diagnostics v_saved_moved = row_count;
  delete from public.saved_jobs s using merge_variants v where s.job_id = v.variant_id;
  get diagnostics v_saved_dropped = row_count;

  with pick as (
    select distinct on (d.user_id, v.keeper_id) d.id
    from public.dismissed_jobs d
    join merge_variants v on v.variant_id = d.job_id
    where not exists (
      select 1 from public.dismissed_jobs k where k.user_id = d.user_id and k.job_id = v.keeper_id
    )
    order by d.user_id, v.keeper_id, d.dismissed_at desc
  )
  update public.dismissed_jobs d set job_id = v.keeper_id
  from pick, merge_variants v
  where d.id = pick.id and v.variant_id = d.job_id;
  get diagnostics v_dism_moved = row_count;
  delete from public.dismissed_jobs d using merge_variants v where d.job_id = v.variant_id;
  get diagnostics v_dism_dropped = row_count;

  -- applications: prefer a confirmed row when two variants compete for one slot.
  -- The BEFORE UPDATE trigger (protect_applications_confirmed_at) is a no-op here:
  -- auth.uid() is null in a migration, and it only pins confirmed_at anyway.
  with pick as (
    select distinct on (a.user_id, v.keeper_id) a.id
    from public.applications a
    join merge_variants v on v.variant_id = a.job_id
    where not exists (
      select 1 from public.applications k where k.user_id = a.user_id and k.job_id = v.keeper_id
    )
    order by a.user_id, v.keeper_id, (a.confirmed_at is null), a.applied_at desc
  )
  update public.applications a set job_id = v.keeper_id
  from pick, merge_variants v
  where a.id = pick.id and v.variant_id = a.job_id;
  get diagnostics v_apps_moved = row_count;
  delete from public.applications a using merge_variants v where a.job_id = v.variant_id;
  get diagnostics v_apps_dropped = row_count;

  -- artifacts: unique on (user_id, job_id, kind) where job_id is not null. A
  -- collision stays on the variant row (user content, never deleted here).
  with pick as (
    select distinct on (a.user_id, v.keeper_id, a.kind) a.id
    from public.artifacts a
    join merge_variants v on v.variant_id = a.job_id
    where not exists (
      select 1 from public.artifacts k
      where k.user_id = a.user_id and k.job_id = v.keeper_id and k.kind = a.kind
    )
    order by a.user_id, v.keeper_id, a.kind, a.updated_at desc
  )
  update public.artifacts a set job_id = v.keeper_id
  from pick, merge_variants v
  where a.id = pick.id and v.variant_id = a.job_id;
  get diagnostics v_art_moved = row_count;
  select count(*) into v_art_left
  from public.artifacts a join merge_variants v on v.variant_id = a.job_id;

  -- 4. retire the variant. Never delete.
  update public.jobs j set is_live = false
  from merge_variants v
  where j.id = v.variant_id and j.is_live;
  get diagnostics v_retired = row_count;

  -- 5. lone rows spelled non-canonically: rewrite the url so the next scrape
  --    refreshes them instead of inserting a twin.
  create temporary table merge_singles on commit drop as
  select
    k.id,
    k.url,
    k.canon,
    case
      when lower(substring(k.url from '^https?://([^/?#]+)')) ~ '\.jobs\.personio\.com$' then 'personio'
      when substring(k.url from '^https?://[^/?#]+(/[^?#]*)') ~ '^/.+/$' then 'trailing-slash'
      else 'case'
    end as class
  from merge_keyed k
  where k.url <> k.canon
    and not exists (select 1 from merge_keyed o where o.canon = k.canon and o.id <> k.id)
    and not exists (select 1 from public.jobs x where x.url = k.canon);

  select count(*) into v_singles from merge_singles;
  select count(*) into v_singles_personio from merge_singles where class = 'personio';
  select count(*) into v_singles_slash from merge_singles where class = 'trailing-slash';
  select count(*) into v_singles_case from merge_singles where class = 'case';

  update public.jobs j set url = s.canon
  from merge_singles s
  where j.id = s.id;

  raise notice 'merge_url_variant_rows: % group(s), % variant row(s) retired now (personio %, trailing-slash %, case %), % group(s) skipped (no canonical row and a created_at tie), % keeper(s) chosen by age with no canonical-form row',
    v_groups, v_retired, v_personio, v_slash, v_case, v_skipped, v_no_canonical;
  raise notice 'merge_url_variant_rows: variants in scope % (retired earlier or now); refs moved/dropped: scores %/%, saved_jobs %/%, dismissed_jobs %/%, applications %/%; artifacts moved %, left on variant %',
    v_variants, v_scores_moved, v_scores_dropped, v_saved_moved, v_saved_dropped, v_dism_moved, v_dism_dropped, v_apps_moved, v_apps_dropped, v_art_moved, v_art_left;
  raise notice 'merge_url_variant_rows: % lone row(s) rewritten to the canonical url (personio %, trailing-slash %, case %)',
    v_singles, v_singles_personio, v_singles_slash, v_singles_case;
end
$$;

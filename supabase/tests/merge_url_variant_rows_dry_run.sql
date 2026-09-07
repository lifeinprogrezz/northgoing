-- READ-ONLY dry run for supabase/migrations/20260907191000_merge_url_variant_rows.sql.
-- Same key, same grouping, same keeper rule, same ref counting. Writes nothing.
-- The operator runs this on production BEFORE applying the migration (runbook in
-- PR #214). src/test/merge-url-variants.test.ts runs it on a fixture and asserts
-- its numbers equal the migration's notices, and that the key expression is
-- byte-identical to the migration's: change them together.
with keyed as (
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
        select sh || regexp_replace(rest, '^(/[^?#]*?)/+((?:[?#].*)?)$', '\1\2') from stripped
      ),
      j.url
    ) as canon
  from public.jobs j
),
groups as (
  select
    canon,
    count(*)::integer as n,
    (array_agg(id order by (url = canon) desc, created_at asc, id asc))[1] as keeper_id,
    bool_or(url = canon) as has_canonical,
    (array_agg(created_at order by created_at asc))[1] = (array_agg(created_at order by created_at asc))[2] as oldest_tie
  from keyed
  group by canon
  having count(*) > 1
),
variants as (
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
  from keyed k
  join groups g on g.canon = k.canon
  where k.id <> g.keeper_id
    and not (g.has_canonical = false and g.oldest_tie)
),
singles as (
  select
    k.id,
    k.url,
    k.canon,
    (g.canon is not null) as is_keeper,
    case
      when lower(substring(k.url from '^https?://([^/?#]+)')) ~ '\.jobs\.personio\.com$' then 'personio'
      when substring(k.url from '^https?://[^/?#]+(/[^?#]*)') ~ '^/.+/$' then 'trailing-slash'
      else 'case'
    end as class
  from keyed k
  left join groups g on g.canon = k.canon
  where k.url <> k.canon
    and (g.canon is null or (k.id = g.keeper_id and not g.has_canonical and not g.oldest_tie))
    and not exists (select 1 from public.jobs x where x.url = k.canon)
),
r_scores as (
  select
    count(*) as on_variants,
    count(distinct (s.user_id, v.keeper_id, s.rubric_version)) filter (where not exists (
      select 1 from public.scores k where k.user_id = s.user_id and k.job_id = v.keeper_id and k.rubric_version = s.rubric_version
    )) as to_move
  from public.scores s join variants v on v.variant_id = s.job_id
),
r_saved as (
  select
    count(*) as on_variants,
    count(distinct (s.user_id, v.keeper_id)) filter (where not exists (
      select 1 from public.saved_jobs k where k.user_id = s.user_id and k.job_id = v.keeper_id
    )) as to_move
  from public.saved_jobs s join variants v on v.variant_id = s.job_id
),
r_dismissed as (
  select
    count(*) as on_variants,
    count(distinct (d.user_id, v.keeper_id)) filter (where not exists (
      select 1 from public.dismissed_jobs k where k.user_id = d.user_id and k.job_id = v.keeper_id
    )) as to_move
  from public.dismissed_jobs d join variants v on v.variant_id = d.job_id
),
r_apps as (
  select
    count(*) as on_variants,
    count(distinct (a.user_id, v.keeper_id)) filter (where not exists (
      select 1 from public.applications k where k.user_id = a.user_id and k.job_id = v.keeper_id
    )) as to_move
  from public.applications a join variants v on v.variant_id = a.job_id
),
r_artifacts as (
  select
    count(*) as on_variants,
    count(distinct (a.user_id, v.keeper_id, a.kind)) filter (where not exists (
      select 1 from public.artifacts k where k.user_id = a.user_id and k.job_id = v.keeper_id and k.kind = a.kind
    )) as to_move
  from public.artifacts a join variants v on v.variant_id = a.job_id
)
select 'groups (keys with more than one row)' as metric, count(*)::bigint as value from groups
union all select 'groups skipped: no canonical row and a created_at tie', count(*) from groups where not has_canonical and oldest_tie
union all select 'keepers chosen by age with no canonical-form row (url rewritten, see below)', count(*) from groups where not has_canonical and not oldest_tie
union all select 'variant rows to retire (is_live = false)', count(*) from variants
union all select 'variant rows: personio .com', count(*) from variants where class = 'personio'
union all select 'variant rows: trailing slash', count(*) from variants where class = 'trailing-slash'
union all select 'variant rows: case / query residue', count(*) from variants where class = 'case'
union all select 'variant rows live today', count(*) from variants where is_live
union all select 'keepers not live while a variant is live (not changed by the migration)', count(distinct v.keeper_id) from variants v join public.jobs j on j.id = v.keeper_id where v.is_live and not j.is_live
union all select 'scores: rows on variants', on_variants from r_scores
union all select 'scores: to move to the keeper', to_move from r_scores
union all select 'scores: to drop (keeper already has that user+rubric)', on_variants - to_move from r_scores
union all select 'saved_jobs: rows on variants', on_variants from r_saved
union all select 'saved_jobs: to move', to_move from r_saved
union all select 'saved_jobs: to drop', on_variants - to_move from r_saved
union all select 'dismissed_jobs: rows on variants', on_variants from r_dismissed
union all select 'dismissed_jobs: to move', to_move from r_dismissed
union all select 'dismissed_jobs: to drop', on_variants - to_move from r_dismissed
union all select 'applications: rows on variants', on_variants from r_apps
union all select 'applications: to move', to_move from r_apps
union all select 'applications: to drop (NOT reversible; status_events/inbound_emails links go null)', on_variants - to_move from r_apps
union all select 'artifacts: rows on variants', on_variants from r_artifacts
union all select 'artifacts: to move', to_move from r_artifacts
union all select 'artifacts: left on the variant row (would collide on user+kind)', on_variants - to_move from r_artifacts
union all select 'rows to rewrite to the canonical url', count(*) from singles
union all select 'rows to rewrite: personio .com', count(*) from singles where class = 'personio'
union all select 'rows to rewrite: trailing slash', count(*) from singles where class = 'trailing-slash'
union all select 'rows to rewrite: case / query residue', count(*) from singles where class = 'case'
union all select 'rows to rewrite: age-chosen keepers of a group with no canonical row', count(*) from singles where is_keeper;

-- READ-ONLY row-level capture for supabase/migrations/20260907191000_merge_url_variant_rows.sql.
-- Run BEFORE the migration and keep the output: it is the only record that makes
-- the moves and the url rewrites reversible (rollback SQL in PR #214). Pinned by
-- src/test/merge-url-variants.test.ts against the migration's key expression.
-- kind = 'variant'  -> id = jobs.id to retire, old_value = its url, ref = keeper id, was_live
-- kind = 'single'   -> id = jobs.id to rewrite (a lone row or an age-chosen keeper), old_value = old url, ref = new url
-- kind = <table>    -> id = that table's row id, ref = old job_id (the variant)
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
    (array_agg(id order by (url = canon) desc, created_at asc, id asc))[1] as keeper_id,
    bool_or(url = canon) as has_canonical,
    (array_agg(created_at order by created_at asc))[1] = (array_agg(created_at order by created_at asc))[2] as oldest_tie
  from keyed
  group by canon
  having count(*) > 1
),
variants as (
  select k.id as variant_id, g.keeper_id, k.url, k.is_live
  from keyed k
  join groups g on g.canon = k.canon
  where k.id <> g.keeper_id
    and not (g.has_canonical = false and g.oldest_tie)
),
singles as (
  select k.id, k.url, k.canon
  from keyed k
  left join groups g on g.canon = k.canon
  where k.url <> k.canon
    and (g.canon is null or (k.id = g.keeper_id and not g.has_canonical and not g.oldest_tie))
    and not exists (select 1 from public.jobs x where x.url = k.canon)
)
select 'variant' as kind, v.variant_id as id, v.url as old_value, v.keeper_id::text as ref, v.is_live as was_live from variants v
union all select 'single', s.id, s.url, s.canon, null from singles s
union all select 'scores', s.id, null, s.job_id::text, null from public.scores s join variants v on v.variant_id = s.job_id
union all select 'saved_jobs', s.id, null, s.job_id::text, null from public.saved_jobs s join variants v on v.variant_id = s.job_id
union all select 'dismissed_jobs', d.id, null, d.job_id::text, null from public.dismissed_jobs d join variants v on v.variant_id = d.job_id
union all select 'applications', a.id, null, a.job_id::text, null from public.applications a join variants v on v.variant_id = a.job_id
union all select 'artifacts', a.id, null, a.job_id::text, null from public.artifacts a join variants v on v.variant_id = a.job_id
order by 1, 2;

-- pg_cron starts the daily scrape (2026-09-07).
--
-- The scrape workflow (scrape.yml) kept GitHub's own schedule when the other
-- three workers moved to pg_cron on 8-27, because it runs on a runner and
-- tick_worker can only make one HTTP call. It got a watchdog instead
-- (20260827200000, moved to 05:15 in 20260831160000).
--
-- Seven mornings out of seven, 9-01 to 9-07, GitHub's `47 3 * * *` fired between
-- 07:52 and 08:55 UTC. Every morning the 05:15 watchdog found the pool about 21
-- hours stale, restarted the workflow and emailed the owner; every 06:00 digest
-- was served from that restart; and GitHub's late run then scraped the whole
-- pool a second time. The 8-28 rule was "third strike and the scrape leaves
-- GitHub cron". So the one HTTP call pg_cron can make is now the call that asks
-- GitHub for the run: api/scrape-dispatch.ts POSTs a workflow_dispatch of
-- scrape.yml on main with reason=scheduled, and scrape.yml has no `schedule:`
-- block any more. The watchdog is unchanged and stays the guard for the morning
-- this dispatch never reaches GitHub.
--
-- This EXTENDS tick_worker the same way the watchdog did: same Vault secret,
-- same allowlist, same no-op while no secret exists. The only change to the
-- function is one more allowed worker name. Idempotent: create or replace, and
-- the job is unscheduled first if it exists.
--
-- 03:47 UTC is the minute the GitHub schedule held, kept on purpose: the ten
-- steps finish well inside the hour, the watchdog checks at 05:15, the scorer
-- runs at 06:00 (nightly.yml), and none of that ordering had to move.
create or replace function public.tick_worker(worker text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  if worker not in ('nightly', 'score-backlog', 'spend-alert', 'scrape-watchdog', 'scrape-dispatch') then
    raise exception 'tick_worker: unknown worker %', worker;
  end if;

  select vs.decrypted_secret into v_secret
    from vault.decrypted_secrets vs
   where vs.name in ('cron_secret_db', 'cron_secret')
   order by case vs.name when 'cron_secret_db' then 0 else 1 end
   limit 1;

  if v_secret is null or length(btrim(v_secret)) = 0 then
    raise notice 'tick_worker(%): no cron secret in vault yet, skipping', worker;
    return;
  end if;

  select net.http_post(
           url := 'https://northgoing.com/api/' || worker,
           body := '{}'::jsonb,
           params := '{}'::jsonb,
           headers := jsonb_build_object(
             'Authorization', 'Bearer ' || v_secret,
             'Content-Type', 'application/json'
           ),
           timeout_milliseconds := 60000
         )
    into v_request_id;

  raise notice 'tick_worker(%): request %', worker, v_request_id;
end;
$$;

comment on function public.tick_worker(text) is
  'Calls one of our own Vercel workers with the cron secret held in Vault (cron_secret_db, or cron_secret if that is the one present). No-ops while neither exists. Called only by pg_cron jobs; never granted to anon or authenticated.';

revoke all on function public.tick_worker(text) from public, anon, authenticated;

select cron.unschedule('northgoing-scrape-dispatch') where exists (select 1 from cron.job where jobname = 'northgoing-scrape-dispatch');

select cron.schedule('northgoing-scrape-dispatch', '47 3 * * *', $$select public.tick_worker('scrape-dispatch')$$);

-- FMBT Cashhhh: the schedule that runs the sync-fixtures function (step 8,
-- fmbt-security section 6).
--
-- Run it by hand in each project's SQL Editor, once these are done:
--   - pg_cron and pg_net are turned on (Database, then Extensions)
--   - Vault holds two secrets, added on its own page, never in a query:
--       project_url   the project's address, like https://abcdefghijklmnopqrst.supabase.co
--       sync_secret   the scheduler secret, the same value as the function's SYNC_SECRET
--
-- The job reads both from Vault each time it runs, so neither one is in this
-- file, in the job or in the SQL Editor's history. Running the file again
-- replaces the jobs rather than adding more.
--
-- To stop the sync:  select cron.unschedule('sync-fixtures');

-- 1. Stop with a clear message if anything's missing, rather than leave a
--    job that fails every minute.
do $$
begin
  if to_regnamespace('cron') is null then
    raise exception 'Turn on the pg_cron extension first (Database, then Extensions).';
  end if;
  if to_regnamespace('net') is null then
    raise exception 'Turn on the pg_net extension first (Database, then Extensions).';
  end if;
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'project_url' and decrypted_secret ~ '^https://[a-z]{20}\.supabase\.co$'
  ) then
    raise exception 'Vault needs a secret named project_url holding the project''s address, like https://abcdefghijklmnopqrst.supabase.co, with nothing after .co.';
  end if;
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'sync_secret' and decrypted_secret ~ '^[A-Za-z0-9]{43,200}$'
  ) then
    raise exception 'Vault needs a secret named sync_secret holding the scheduler secret: 43 or more letters and digits.';
  end if;
end
$$;

-- 2. Every minute, ask the function to run. It decides for itself whether
--    football-data needs asking. pg_net waits up to 30 seconds for the answer,
--    since its default is too short for a full refresh.
select cron.schedule(
  'sync-fixtures',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-fixtures',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Sync-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$
);

-- 3. Every day at 04:23 UTC, delete the scheduler's run history older than a
--    week. pg_cron keeps a row for every run, about 1 MB a day at one a
--    minute, which would fill most of the free database within a year.
select cron.schedule(
  'clean-cron-history',
  '23 4 * * *',
  $job$ delete from cron.job_run_details where end_time < now() - interval '7 days' $job$
);

-- 4. What's scheduled now: the two jobs above, both active.
select jobname, schedule, active from cron.job order by jobname;

-- =====================================================================
-- FMBT Cashhhh database, version 1
-- Draft from step 5, tested 26 October 2026 against PostgreSQL 17.
-- It becomes the first migration at step 6, after we walk through it.
--
-- What this file does, in order:
--   1. Makes new tables and functions start with no access at all.
--   2. Creates the private schema for things only the server touches.
--   3. Creates the shared football tables: teams, fixtures, sync status.
--   4. Creates your encrypted tables: week versions, settings, key wraps, audit log.
--   5. Adds the access rules, the exact permissions, and storage limits.
--   6. Adds the sign-up check, the no-email hook, recovery and invites.
--
-- Who's who:
--   anon                 anyone holding the public key, signed out
--   authenticated        anyone signed in (you or a friend)
--   service_role         server code using a secret key
--   supabase_auth_admin  Supabase's sign-up system, which runs the two hooks
--   postgres             the owner: you, in the dashboard's SQL editor
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Start closed
-- ---------------------------------------------------------------------
-- Supabase normally lets anon, authenticated and service_role use every
-- new table and function in public. These lines stop that for anything
-- created from here on, so a forgotten permission fails safe (no access)
-- instead of open.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;
-- Postgres also lets everyone run new functions by default. Turn that off too.
alter default privileges for role postgres
  revoke execute on functions from public;


-- ---------------------------------------------------------------------
-- 2. The private schema
-- ---------------------------------------------------------------------
-- The Data API only exposes the public schema, so nothing in here can be
-- reached from a browser. Only the grants further down open small doors.

create schema private;


-- ---------------------------------------------------------------------
-- Shared value rules (domains)
-- ---------------------------------------------------------------------
-- A domain is a type with a built-in check, so the same rule applies to
-- every column that uses it.

create domain public.competition_code as text
  check (value in ('PL', 'UCL'));

-- Season by its starting year: 2026 means 2026/27.
create domain public.season_year as smallint
  check (value between 2020 and 2100);

-- MW1 to MW38 for the Premier League. MD1 to MD8, KPO (knockout play-off),
-- R16, QF, SF and F for the Champions League.
create domain public.period_code as text
  check (value ~ '^(MW([1-9]|[12][0-9]|3[0-8])|MD[1-8]|KPO|R16|QF|SF|F)$');

create domain public.goal_count as smallint
  check (value between 0 and 30);

-- Encryption settings version: which key derivation and cipher settings
-- made a record, so they can be upgraded later.
create domain public.crypto_version as smallint
  check (value between 1 and 100);

-- A 12-byte AES-GCM IV in base64 is exactly 16 characters.
create domain public.b64_iv as text
  check (value ~ '^[A-Za-z0-9+/]{16}$');

-- A wrapped 32-byte key plus its 16-byte check value is 48 bytes:
-- exactly 64 base64 characters.
create domain public.b64_wrapped_key as text
  check (value ~ '^[A-Za-z0-9+/]{64}$');

-- Records are padded to at least 1,024 bytes before encrypting, so the
-- smallest ciphertext is 1,040 bytes (1,388 base64 characters). The top
-- limit is about 260 KB.
create domain public.b64_ciphertext as text
  check (char_length(value) between 1388 and 350000
         and value ~ '^[A-Za-z0-9+/]+={0,2}$');


-- ---------------------------------------------------------------------
-- 3. Shared football tables (public information, not encrypted)
-- ---------------------------------------------------------------------

create table public.teams (
  id integer primary key,                         -- football-data's team id
  name text not null
    check (char_length(name) between 1 and 80),   -- "Manchester City FC"
  short_name text not null
    check (char_length(short_name) between 1 and 40),  -- "Man City"
  code text not null
    check (code ~ '^[A-Z]{3}$'),                  -- badge code, like MCI
  updated_at timestamptz not null default now()
);

create table public.fixtures (
  id bigint primary key,                          -- football-data's match id
  competition public.competition_code not null,
  season public.season_year not null,
  period public.period_code not null,
  tie_leg smallint check (tie_leg in (1, 2)),     -- leg of a two-legged tie, if any
  kickoff timestamptz not null,
  home_team_id integer not null references public.teams (id),
  away_team_id integer not null references public.teams (id),
  status text not null check (status in (
    'scheduled', 'live', 'half_time', 'extra_time', 'penalties',
    'finished', 'postponed', 'suspended', 'cancelled', 'awarded')),
  minute smallint check (minute between 0 and 130),   -- only if the feed gives it
  -- Scores. Bets settle on the 90-minute score and nothing else.
  home_90 public.goal_count,     -- after 90 minutes (the running score while live)
  away_90 public.goal_count,
  home_ht public.goal_count,     -- half-time
  away_ht public.goal_count,
  home_et public.goal_count,     -- goals in extra time only
  away_et public.goal_count,
  home_pens public.goal_count,   -- shootout only
  away_pens public.goal_count,
  feed_updated_at timestamptz,   -- when football-data last changed this match
  updated_at timestamptz not null default now(),
  check (home_team_id <> away_team_id),
  check ((competition = 'PL') = (period like 'MW%')),
  check ((home_90 is null) = (away_90 is null)),
  check ((home_ht is null) = (away_ht is null)),
  check ((home_et is null) = (away_et is null)),
  check ((home_pens is null) = (away_pens is null))
);

create index fixtures_by_week on public.fixtures (competition, season, period);
create index fixtures_by_kickoff on public.fixtures (kickoff);

-- One row saying when the sync last ran, so the app can show
-- "Scores checked 1 min ago".
create table public.sync_status (
  id boolean primary key default true check (id),   -- there's only ever one row
  last_attempt_at timestamptz,
  last_success_at timestamptz
);
insert into public.sync_status (id) values (true);


-- ---------------------------------------------------------------------
-- 4. Your encrypted tables
-- ---------------------------------------------------------------------
-- Every row here is ciphertext plus the few plain columns needed to file
-- it. The browser binds every plain column except user_id and created_at
-- into the encryption, so moving or relabelling a row makes it fail to
-- decrypt. user_id is left out so a backup can be restored into a fresh
-- project, where your account would get a new ID.
--
-- Rows are never edited. Each save adds a new version with the next
-- version number. If two tabs save the same week at once, the second one
-- hits the unique rule and the app asks you to reload.

-- One row per saved version of one week's or stage's bets.
create table public.week_versions (
  id uuid primary key,             -- made by the browser before encrypting
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  season public.season_year not null,
  competition public.competition_code not null,
  period public.period_code not null,
  version_no integer not null check (version_no between 1 and 1000000),
  v public.crypto_version not null,
  iv public.b64_iv not null,
  ct public.b64_ciphertext not null,
  ct_bytes integer generated always as (octet_length(ct)) stored,  -- for the storage limit
  created_at timestamptz not null default now(),
  unique (user_id, season, competition, period, version_no),
  check ((competition = 'PL') = (period like 'MW%'))
);

-- Settings such as when you last took a backup.
create table public.settings_versions (
  id uuid primary key,
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  version_no integer not null check (version_no between 1 and 1000000),
  v public.crypto_version not null,
  iv public.b64_iv not null,
  ct public.b64_ciphertext not null,
  ct_bytes integer generated always as (octet_length(ct)) stored,
  created_at timestamptz not null default now(),
  unique (user_id, version_no)
);

-- Your data key, wrapped by your password's key or by your recovery key.
create table public.key_wraps (
  id uuid primary key,
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  kind text not null check (kind in ('password', 'recovery')),
  version_no integer not null check (version_no between 1 and 1000000),
  v public.crypto_version not null,
  iv public.b64_iv not null,
  wrapped public.b64_wrapped_key not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, version_no)
);

-- Changes to locked weeks. seq counts 1, 2, 3 with no gaps, and each entry
-- carries the SHA-256 of the previous entry's ciphertext, so a missing or
-- reordered entry shows up.
create table public.audit_entries (
  id uuid primary key,
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  seq integer not null check (seq between 1 and 1000000),
  prev_hash text check (prev_hash ~ '^[0-9a-f]{64}$'),
  v public.crypto_version not null,
  iv public.b64_iv not null,
  ct public.b64_ciphertext not null,
  ct_bytes integer generated always as (octet_length(ct)) stored,
  created_at timestamptz not null default now(),
  unique (user_id, seq),
  check ((seq = 1) = (prev_hash is null))
);

-- The newest version of each week, which is what the app loads first.
-- security_invoker makes the view obey your access rules instead of
-- running with its creator's rights.
create view public.latest_week_versions
  with (security_invoker = true) as
  select distinct on (user_id, season, competition, period)
         id, user_id, season, competition, period, version_no, v, iv, ct, created_at
  from public.week_versions
  order by user_id, season, competition, period, version_no desc;


-- ---------------------------------------------------------------------
-- 5. Access rules, permissions and storage limits
-- ---------------------------------------------------------------------

alter table public.teams enable row level security;
alter table public.fixtures enable row level security;
alter table public.sync_status enable row level security;
alter table public.week_versions enable row level security;
alter table public.settings_versions enable row level security;
alter table public.key_wraps enable row level security;
alter table public.audit_entries enable row level security;

-- Football data: anyone signed in can read it. Only server code writes it,
-- and its secret key skips these rules, so no write rules are needed.
create policy "signed-in users read teams"
  on public.teams for select to authenticated using (true);
create policy "signed-in users read fixtures"
  on public.fixtures for select to authenticated using (true);
create policy "signed-in users read sync status"
  on public.sync_status for select to authenticated using (true);

-- Your data: you can read and add your own rows. There are no update rules
-- anywhere, and no delete rules except for old key wraps.
-- (select auth.uid()) is worked out once per query instead of once per row.
create policy "read own week versions"
  on public.week_versions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "add own week versions"
  on public.week_versions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "read own settings versions"
  on public.settings_versions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "add own settings versions"
  on public.settings_versions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "read own key wraps"
  on public.key_wraps for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "add own key wraps"
  on public.key_wraps for insert to authenticated
  with check ((select auth.uid()) = user_id);
-- Old key wraps are cleared by delete_old_key_wraps() in section 6, never
-- by a direct delete. (A delete rule that looks at its own table makes
-- Postgres stop with "infinite recursion", which the tests caught.)

create policy "read own audit entries"
  on public.audit_entries for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "add own audit entries"
  on public.audit_entries for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Permissions. Wipe whatever Supabase granted, then grant exactly what's
-- used. Inserts name their columns, so the browser can't set user_id,
-- created_at or ct_bytes itself. Secret keys (service_role) get nothing
-- on your tables, so a leaked secret key can't read or delete your data
-- through the API.
revoke all on
  public.teams, public.fixtures, public.sync_status,
  public.week_versions, public.settings_versions, public.key_wraps,
  public.audit_entries, public.latest_week_versions
  from anon, authenticated, service_role;

grant select on public.teams, public.fixtures, public.sync_status to authenticated;
grant select, insert, update on public.teams, public.fixtures, public.sync_status to service_role;

grant select on
  public.week_versions, public.settings_versions, public.key_wraps,
  public.audit_entries, public.latest_week_versions
  to authenticated;
grant insert (id, season, competition, period, version_no, v, iv, ct)
  on public.week_versions to authenticated;
grant insert (id, version_no, v, iv, ct)
  on public.settings_versions to authenticated;
grant insert (id, kind, version_no, v, iv, wrapped)
  on public.key_wraps to authenticated;
grant insert (id, seq, prev_hash, v, iv, ct)
  on public.audit_entries to authenticated;

-- Saved rows never change. These triggers stop edits even by the owner or
-- a secret key. The one exception: rows can go when their whole account
-- is deleted, which arrives as a cascade (trigger depth above 1).
create function private.block_changes() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% rows can only be added, never changed or removed.', tg_table_name;
end;
$$;

create trigger week_versions_never_change
  before update or delete on public.week_versions
  for each row execute function private.block_changes();
create trigger week_versions_never_truncate
  before truncate on public.week_versions
  for each statement execute function private.block_changes();

create trigger settings_versions_never_change
  before update or delete on public.settings_versions
  for each row execute function private.block_changes();
create trigger settings_versions_never_truncate
  before truncate on public.settings_versions
  for each statement execute function private.block_changes();

create trigger audit_entries_never_change
  before update or delete on public.audit_entries
  for each row execute function private.block_changes();
create trigger audit_entries_never_truncate
  before truncate on public.audit_entries
  for each statement execute function private.block_changes();

-- Key wraps can be deleted (only by delete_old_key_wraps) but never edited.
create trigger key_wraps_never_change
  before update on public.key_wraps
  for each row execute function private.block_changes();
create trigger key_wraps_never_truncate
  before truncate on public.key_wraps
  for each statement execute function private.block_changes();

-- Storage limits per account, so one account can't fill the free
-- database for everyone. Arguments: most rows, most ciphertext bytes
-- (0 means no byte limit).
create function private.enforce_quota() returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  max_rows integer := tg_argv[0]::integer;
  max_bytes bigint := tg_argv[1]::bigint;
  used_rows integer;
  used_bytes bigint;
begin
  if max_bytes > 0 then
    execute format(
      'select count(*), coalesce(sum(ct_bytes), 0) from %I.%I where user_id = $1',
      tg_table_schema, tg_table_name)
      into used_rows, used_bytes using new.user_id;
  else
    execute format('select count(*) from %I.%I where user_id = $1',
      tg_table_schema, tg_table_name)
      into used_rows using new.user_id;
    used_bytes := 0;
  end if;
  if used_rows >= max_rows then
    raise exception 'Storage limit reached for %.', tg_table_name;
  end if;
  -- Kept in its own block: key_wraps has no ct column, and this line only
  -- runs for tables that do.
  if max_bytes > 0 then
    if used_bytes + octet_length(new.ct) > max_bytes then
      raise exception 'Storage limit reached for %.', tg_table_name;
    end if;
  end if;
  return new;
end;
$$;

create trigger week_versions_quota before insert on public.week_versions
  for each row execute function private.enforce_quota('20000', '25000000');
create trigger settings_versions_quota before insert on public.settings_versions
  for each row execute function private.enforce_quota('2000', '2000000');
create trigger audit_entries_quota before insert on public.audit_entries
  for each row execute function private.enforce_quota('20000', '5000000');
create trigger key_wraps_quota before insert on public.key_wraps
  for each row execute function private.enforce_quota('200', '0');


-- ---------------------------------------------------------------------
-- 6. Sign-up check, the no-email hook, recovery and invites
-- ---------------------------------------------------------------------

-- Supabase's sign-up system runs the hooks as supabase_auth_admin. It gets
-- into the private schema only as far as these grants allow.
grant usage on schema private to supabase_auth_admin;

-- The invite list. You manage it from Settings (functions below) or the
-- dashboard. Friends' emails live only here, never in the repo.
create table private.invites (
  email text primary key
    check (email = lower(btrim(email))
           and char_length(email) <= 254
           and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  added_at timestamptz not null default now()
);
alter table private.invites enable row level security;
create policy "sign-up system reads invites"
  on private.invites for select to supabase_auth_admin using (true);
grant select on private.invites to supabase_auth_admin;

-- Before User Created hook. It allows a sign-up only when the email is on
-- the list. Anything else, including a missing email, is a rejection.
create function private.before_user_created(event jsonb) returns jsonb
  language plpgsql
  set search_path = ''
as $$
declare
  new_email text := lower(btrim(event -> 'user' ->> 'email'));
begin
  if new_email is not null
     and exists (select 1 from private.invites i where i.email = new_email) then
    return '{}'::jsonb;   -- allowed
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This email doesn''t have an invite.'));
end;
$$;
grant execute on function private.before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function private.before_user_created(jsonb) from public, anon, authenticated, service_role;

-- Send Email hook. It replaces Supabase's mailer and sends nothing, so no
-- email can reset a password or sign anyone in. It notes who and what kind
-- of email was asked for, never the code or link inside it.
create table private.email_hook_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  action text not null check (char_length(action) <= 60),
  at timestamptz not null default now()
);
alter table private.email_hook_log enable row level security;
create policy "sign-up system writes the email log"
  on private.email_hook_log for insert to supabase_auth_admin with check (true);
grant insert on private.email_hook_log to supabase_auth_admin;

create function private.send_email(event jsonb) returns jsonb
  language plpgsql
  set search_path = ''
as $$
begin
  begin
    insert into private.email_hook_log (user_id, action)
    values (
      (event -> 'user' ->> 'id')::uuid,
      left(coalesce(event -> 'email_data' ->> 'email_action_type', 'unknown'), 60));
  exception when others then
    null;   -- a bad payload must never stop the hook returning "sent"
  end;
  return '{}'::jsonb;   -- Supabase counts this as sent; nothing was
end;
$$;
grant execute on function private.send_email(jsonb) to supabase_auth_admin;
revoke execute on function private.send_email(jsonb) from public, anon, authenticated, service_role;

-- Browser, in Admin mode: save a locked week's new version and its audit
-- entry together. Either both are saved or neither is. It runs with your
-- own permissions (security invoker), so it can't do anything you
-- couldn't do with two separate inserts.
create function public.save_week_with_audit(
  week_id uuid, week_season smallint, week_competition text, week_period text,
  week_version_no integer, week_v smallint, week_iv text, week_ct text,
  audit_id uuid, audit_seq integer, audit_prev_hash text,
  audit_v smallint, audit_iv text, audit_ct text)
  returns void
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  insert into public.week_versions (id, season, competition, period, version_no, v, iv, ct)
  values (week_id, week_season, week_competition, week_period, week_version_no, week_v, week_iv, week_ct);
  insert into public.audit_entries (id, seq, prev_hash, v, iv, ct)
  values (audit_id, audit_seq, audit_prev_hash, audit_v, audit_iv, audit_ct);
end;
$$;
revoke execute on function public.save_week_with_audit(uuid, smallint, text, text, integer, smallint, text, text, uuid, integer, text, smallint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_week_with_audit(uuid, smallint, text, text, integer, smallint, text, text, uuid, integer, text, smallint, text, text)
  to authenticated;

-- Browser, after a password change or recovery has been proven to work:
-- delete every key wrap that has a newer one of the same kind. The newest
-- password wrap and the newest recovery wrap always survive. Returns how
-- many were deleted.
create function public.delete_old_key_wraps() returns integer
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  me uuid := auth.uid();
  removed integer;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;
  delete from public.key_wraps k
   where k.user_id = me
     and exists (
       select 1 from public.key_wraps newer
        where newer.user_id = me
          and newer.kind = k.kind
          and newer.version_no > k.version_no);
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke execute on function public.delete_old_key_wraps() from public, anon, authenticated, service_role;
grant execute on function public.delete_old_key_wraps() to authenticated;

-- Recovery. The browser derives a proof from your recovery key. The
-- database keeps only the SHA-256 of that proof.
create table private.recovery_proofs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  proof_hash bytea not null check (octet_length(proof_hash) = 32),
  updated_at timestamptz not null default now()
);
alter table private.recovery_proofs enable row level security;

create table private.recovery_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  ok boolean not null,
  at timestamptz not null default now()
);
alter table private.recovery_attempts enable row level security;

-- Browser: save your recovery proof. The first one can be set freely.
-- Replacing it needs the current proof, so someone holding your session
-- can't swap in their own recovery key.
create function public.set_recovery_proof(new_proof_hash_hex text, current_proof_hex text default null)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  me uuid := auth.uid();
  saved bytea;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;
  if new_proof_hash_hex is null or new_proof_hash_hex !~ '^[0-9a-f]{64}$' then
    raise exception 'Bad recovery proof.';
  end if;
  select proof_hash into saved from private.recovery_proofs where user_id = me for update;
  if saved is null then
    insert into private.recovery_proofs (user_id, proof_hash)
    values (me, decode(new_proof_hash_hex, 'hex'));
  elsif current_proof_hex ~ '^[0-9a-f]{64}$'
        and sha256(decode(current_proof_hex, 'hex')) = saved then
    update private.recovery_proofs
       set proof_hash = decode(new_proof_hash_hex, 'hex'), updated_at = now()
     where user_id = me;
  else
    raise exception 'Bad recovery proof.';
  end if;
end;
$$;
revoke execute on function public.set_recovery_proof(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_recovery_proof(text, text) to authenticated;

-- Recovery server function only: is this proof right for this email?
-- Returns the account ID, or null for every kind of failure, so the
-- answer never says whether the email exists. Five wrong tries in 24
-- hours locks recovery for that account until the next day. Tries
-- against unknown emails aren't stored, so spamming them fills nothing.
create function public.recovery_check(p_email text, p_proof_hex text)
  returns uuid
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  account uuid;
  fails integer;
  ok boolean;
begin
  select u.id into account from auth.users u where u.email = lower(btrim(p_email));
  if account is null or p_proof_hex is null or p_proof_hex !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select count(*) into fails from private.recovery_attempts a
   where a.user_id = account
     and not a.ok
     and a.at > now() - interval '24 hours';
  if fails >= 5 then
    return null;
  end if;
  ok := exists (
    select 1 from private.recovery_proofs r
     where r.user_id = account
       and r.proof_hash = sha256(decode(p_proof_hex, 'hex')));
  insert into private.recovery_attempts (user_id, ok) values (account, ok);
  return case when ok then account end;
end;
$$;
revoke execute on function public.recovery_check(text, text) from public, anon, authenticated, service_role;
grant execute on function public.recovery_check(text, text) to service_role;

-- Invites from the Settings page, for app admins only (you). Add yourself
-- once in the SQL editor after you sign up:
--   insert into private.app_admins (user_id) values ('<your user id>');
create table private.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table private.app_admins enable row level security;

create function private.is_app_admin() returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (select 1 from private.app_admins a where a.user_id = auth.uid());
$$;
revoke execute on function private.is_app_admin() from public, anon, authenticated, service_role;

create function public.invite_list()
  returns table (email text, added_at timestamptz, has_account boolean)
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if not private.is_app_admin() then
    raise exception 'Not allowed.';
  end if;
  return query
    select i.email, i.added_at,
           exists (select 1 from auth.users u where u.email = i.email)
      from private.invites i
     order by i.added_at desc;
end;
$$;

create function public.invite_add(p_email text) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if not private.is_app_admin() then
    raise exception 'Not allowed.';
  end if;
  insert into private.invites (email) values (lower(btrim(p_email)))
  on conflict (email) do nothing;
end;
$$;

create function public.invite_remove(p_email text) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if not private.is_app_admin() then
    raise exception 'Not allowed.';
  end if;
  delete from private.invites where email = lower(btrim(p_email));
end;
$$;

revoke execute on function public.invite_list() from public, anon, authenticated, service_role;
revoke execute on function public.invite_add(text) from public, anon, authenticated, service_role;
revoke execute on function public.invite_remove(text) from public, anon, authenticated, service_role;
grant execute on function public.invite_list() to authenticated;
grant execute on function public.invite_add(text) to authenticated;
grant execute on function public.invite_remove(text) to authenticated;

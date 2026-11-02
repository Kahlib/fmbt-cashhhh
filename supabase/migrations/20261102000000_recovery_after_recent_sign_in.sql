-- =====================================================================
-- FMBT Cashhhh: a new recovery key after a recent password sign-in
-- Step 7.3, 2 November 2026. Runs after 20261026000000_init.sql.
-- =====================================================================
--
-- Until now, replacing your recovery proof needed the current one, so a
-- lost recovery key could never be replaced. This lets a password sign-in
-- from the last 5 minutes replace it too. Settings asks for your password
-- and signs in again just before saving a new key.
--
-- How the function knows when you signed in: every access token carries an
-- "amr" claim, a list of how and when this session signed in, such as
-- [{"method": "password", "timestamp": 1793612345}]. Supabase sets that time
-- when you sign in and keeps it when the session refreshes, so a session
-- that's merely been kept alive can't pass. Forgot password still passes
-- the old proof, as before.
--
-- "create or replace" keeps the function's name, arguments, owner and
-- permissions, so the Security Advisor's list doesn't change.

create or replace function public.set_recovery_proof(new_proof_hash_hex text, current_proof_hex text default null)
  returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  me uuid := auth.uid();
  saved bytea;
  signed_in_recently boolean;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;
  if new_proof_hash_hex is null or new_proof_hash_hex !~ '^[0-9a-f]{64}$' then
    raise exception 'Bad recovery proof.';
  end if;

  -- A password sign-in within the last 5 minutes (300 seconds), allowing a
  -- minute of clock difference the other way. Anything that isn't a list of
  -- objects with a numeric timestamp counts as no sign-in at all.
  select exists (
    select 1
      from jsonb_array_elements(
             case when jsonb_typeof(auth.jwt() -> 'amr') = 'array'
                  then auth.jwt() -> 'amr'
                  else '[]'::jsonb end) as entry
     where jsonb_typeof(entry) = 'object'
       and entry ->> 'method' = 'password'
       and jsonb_typeof(entry -> 'timestamp') = 'number'
       and (entry ->> 'timestamp')::numeric
           between extract(epoch from now()) - 300 and extract(epoch from now()) + 60
  ) into signed_in_recently;

  select proof_hash into saved from private.recovery_proofs where user_id = me for update;
  if saved is null then
    -- The first proof, made at setup.
    insert into private.recovery_proofs (user_id, proof_hash)
    values (me, decode(new_proof_hash_hex, 'hex'));
  elsif signed_in_recently
        or (current_proof_hex ~ '^[0-9a-f]{64}$'
            and sha256(decode(current_proof_hex, 'hex')) = saved) then
    update private.recovery_proofs
       set proof_hash = decode(new_proof_hash_hex, 'hex'), updated_at = now()
     where user_id = me;
  else
    raise exception 'Bad recovery proof.';
  end if;
end;
$$;

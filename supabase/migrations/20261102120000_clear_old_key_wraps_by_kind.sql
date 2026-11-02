-- =====================================================================
-- FMBT Cashhhh: clear old key wraps one kind at a time
-- Step 7.4, 2 November 2026. Runs after 20261102000000_recovery_after_recent_sign_in.sql.
-- =====================================================================
--
-- delete_old_key_wraps() used to clear old password wraps and old recovery
-- wraps together. That leaves one way to lose your recovery key: if saving
-- a new recovery key stopped halfway, after its wrap was saved but before
-- its proof was, the next password change would delete the old recovery
-- key's wrap, the only one that still works.
--
-- Now each key change clears only its own kind:
--   - a password change clears old password wraps
--   - a new recovery key clears old recovery wraps, only once its proof is saved
-- The newest wrap of the kind always survives, as before.
--
-- The function's arguments change, so the old one is dropped and the new
-- one gets its permissions from scratch. Its name stays the same, so the
-- Security Advisor's list and the permissions report don't change.

drop function public.delete_old_key_wraps();

create function public.delete_old_key_wraps(only_kind text) returns integer
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
  if only_kind is null or only_kind not in ('password', 'recovery') then
    raise exception 'Unknown key wrap kind.';
  end if;
  delete from public.key_wraps k
   where k.user_id = me
     and k.kind = only_kind
     and exists (
       select 1 from public.key_wraps newer
        where newer.user_id = me
          and newer.kind = k.kind
          and newer.version_no > k.version_no);
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke execute on function public.delete_old_key_wraps(text) from public, anon, authenticated, service_role;
grant execute on function public.delete_old_key_wraps(text) to authenticated;

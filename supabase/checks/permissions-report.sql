-- FMBT Cashhhh: who can do what, read straight from the database.
-- Paste into the Supabase SQL editor and run. It changes nothing.
-- Compare the results with the expected tables in the step 6 setup guide.

-- 1. Tables and views in public: row-level security, and each role's permissions.
select
  c.relname as name,
  case c.relkind when 'v' then 'view' else 'table' end as kind,
  case when c.relkind = 'v' then 'follows its table'
       when c.relrowsecurity then 'on' else 'OFF' end as row_security,
  coalesce((select string_agg(g.privilege_type, ', ' order by g.privilege_type)
              from information_schema.role_table_grants g
             where g.table_schema = 'public' and g.table_name = c.relname
               and g.grantee = 'anon'), '-') as signed_out,
  coalesce((select string_agg(g.privilege_type, ', ' order by g.privilege_type)
              from information_schema.role_table_grants g
             where g.table_schema = 'public' and g.table_name = c.relname
               and g.grantee = 'authenticated'), '-') as signed_in,
  coalesce((select string_agg(p.column_name, ', ' order by p.column_name)
              from information_schema.column_privileges p
             where p.table_schema = 'public' and p.table_name = c.relname
               and p.grantee = 'authenticated' and p.privilege_type = 'INSERT'
               and not exists (select 1 from information_schema.role_table_grants g
                                where g.table_schema = 'public' and g.table_name = c.relname
                                  and g.grantee = 'authenticated' and g.privilege_type = 'INSERT')),
           '-') as signed_in_can_add,
  coalesce((select string_agg(g.privilege_type, ', ' order by g.privilege_type)
              from information_schema.role_table_grants g
             where g.table_schema = 'public' and g.table_name = c.relname
               and g.grantee = 'service_role'), '-') as secret_key
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'v')
order by kind, name;

-- 2. Functions: who can run each one, and which run with the owner's rights.
select
  n.nspname || '.' || p.proname as function,
  has_function_privilege('anon', p.oid, 'execute') as signed_out,
  has_function_privilege('authenticated', p.oid, 'execute') as signed_in,
  has_function_privilege('service_role', p.oid, 'execute') as secret_key,
  has_function_privilege('supabase_auth_admin', p.oid, 'execute') as sign_up_system,
  p.prosecdef as runs_as_owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private')
order by 1;

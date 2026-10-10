-- ============================================================================
-- 0007_access_log_local.sql — access log for the local employee login
--
-- The web login is now a local employee gate (Emp Code + shared password); there
-- is no Supabase session/auth.uid() anymore. These functions learn the caller
-- from the employee session instead:
--
--   * user_id   : uuid -> text so it can hold the employee code
--   * log_access(p_emp_code, p_emp_name, p_role)   : records an app-open.
--                     Falls back to the old auth.uid() path when no employee
--                     code is supplied (keeps old GoTrue sessions working).
--   * get_access_report(p_date_from, p_date_to, p_admin_code) : admin-only daily
--                     per-user aggregation. The caller passes the signed-in
--                     admin's employee code; get_my_role() still works for
--                     Supabase-auth'd admins.
--
-- Paste the WHOLE file into the Supabase SQL Editor and run it AFTER 0005.
-- ============================================================================

alter table public.access_log alter column user_id type text;

-- ---------------------------------------------------------------------------
-- Record a visit. SECURITY DEFINER so anon callers can write their own row.
-- ---------------------------------------------------------------------------
drop function if exists public.log_access();
create or replace function public.log_access(
  p_emp_code text default null,
  p_emp_name text default null,
  p_role     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if p_emp_code is not null and p_emp_code <> '' then
    insert into public.access_log (user_id, email, role)
    values (p_emp_code,
            coalesce(p_emp_name, 'unknown'),
            coalesce(p_role, 'viewer'));
    return;
  end if;
  if uid is null then
    return;
  end if;
  insert into public.access_log (user_id, email, role)
  select uid::text,
         coalesce((select email from public.user_roles where user_id = uid),
                  (select email from auth.users        where id     = uid),
                  'unknown'),
         coalesce((select role  from public.user_roles where user_id = uid), 'viewer');
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin-only: daily per-user aggregation.
-- ---------------------------------------------------------------------------
drop function if exists public.get_access_report(date, date);
create or replace function public.get_access_report(
  p_date_from   date   default null,
  p_date_to     date   default null,
  p_admin_code  text   default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(p_admin_code, '') <> 'Adminmis01'
     and public.get_my_role() is distinct from 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'day',        d.visit_date,
             'email',      d.email,
             'role',       d.role,
             'visits',     d.visits,
             'first_seen', d.first_seen,
             'last_seen',  d.last_seen)
           order by d.visit_date desc, d.email)
    from (
      select visit_date,
             coalesce(email, 'unknown') as email,
             coalesce(role,  'viewer')  as role,
             count(*)                    as visits,
             min(visited_at)             as first_seen,
             max(visited_at)             as last_seen
      from public.access_log
      where (p_date_from is null or visit_date >= p_date_from)
        and (p_date_to   is null or visit_date <= p_date_to)
      group by visit_date, coalesce(email, 'unknown'), coalesce(role, 'viewer')
    ) d
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.log_access(text, text, text) to anon, authenticated;
grant execute on function public.get_access_report(date, date, text) to anon, authenticated;
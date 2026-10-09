-- ============================================================================
-- 0005_access_log.sql — dashboard usage / access audit log
--
-- Records every time a signed-in user opens the app, so the admin can monitor,
-- per day, how many viewers used the dashboard and with which account.
--
--   * access_log        : one row per app-open (user, role, timestamp, date)
--   * log_access()      : SECURITY DEFINER — records the *caller* only. Viewers
--                         can write their own visit but never read the log.
--   * get_access_report(): SECURITY DEFINER + admin-only — daily per-user
--                         aggregation (date, email, role, visits, first/last).
--
-- RLS is enabled with NO policies, so direct select/insert is denied for
-- anon/authenticated; access is only through the two functions above (and the
-- service role). Dates are bucketed in UTC.
-- ============================================================================

create table if not exists public.access_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  email      text,
  role       text,
  visited_at timestamptz not null default now(),
  visit_date date not null default ((now() at time zone 'utc')::date)
);

create index if not exists access_log_date_idx      on public.access_log (visit_date);
create index if not exists access_log_user_date_idx on public.access_log (user_id, visit_date);

alter table public.access_log enable row level security;

-- No policies: nobody reads/writes directly. The definer functions bypass RLS.
revoke all on table public.access_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Record a visit for the calling user (auth.uid()).
-- ---------------------------------------------------------------------------
create or replace function public.log_access()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return;
  end if;
  insert into public.access_log (user_id, email, role)
  select uid,
         coalesce((select email from public.user_roles where user_id = uid),
                  (select email from auth.users        where id     = uid),
                  'unknown'),
         coalesce((select role  from public.user_roles where user_id = uid), 'viewer');
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin-only: daily per-user aggregation.
-- ---------------------------------------------------------------------------
create or replace function public.get_access_report(
  p_date_from date default null,
  p_date_to   date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.get_my_role() is distinct from 'admin' then
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

revoke execute on function public.log_access()        from anon, public;
revoke execute on function public.get_access_report(date, date) from anon, public;
grant  execute on function public.log_access()        to authenticated;
grant  execute on function public.get_access_report(date, date) to authenticated;

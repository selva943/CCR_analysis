-- ============================================================================
-- 0004_auth.sql — roles, admin auth, and read/write enforcement (Phase 5)
--
-- "Make the dashboard a live database-connected project with authentication":
--   * exactly ONE admin and up to N viewers (any number; task spec = 7)
--   * admin can process (import) the data; viewers can only view
--   * anonymous unauthenticated access is revoked
--
-- Design:
--   * user_roles  : user_id -> role ('admin' | 'viewer'). The single source of
--                    truth for who can do what. Admin provisioning happens
--                    through the Dashboard (Auth > Users) or scripts.
--   * is_admin()  : security definer helper used by RLS policies AND the
--                    FastAPI backend for the admin-only import path.
--   * get_my_role(): RPC the browser calls right after sign-in so the UI can
--                    hide/show the "process the data" controls.
--   * RLS:
--       - ccr_raw / ccr_import_jobs : SELECT only for authenticated users
--                                     (viewers and admin). INSERT/UPDATE/DELETE
--                                     only for admin (defence in depth; the
--                                     real import runs with the service role).
--       - user_roles                 : admin manages everyone; users read only
--                                     their own row.
--   * All data RPCs are revoked from `anon` and granted to `authenticated`.
--
-- Order matters: user_roles + is_admin() must exist before the policies.
-- Paste the WHOLE file into the Supabase SQL Editor and run it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Roles table
-- ---------------------------------------------------------------------------
create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;

drop policy if exists user_roles_admin_all on public.user_roles;
drop policy if exists user_roles_self_read on public.user_roles;
drop policy if exists user_roles_anon_read on public.user_roles;

-- ---------------------------------------------------------------------------
-- Role helpers (security definer so RLS on user_roles does not block them).
-- NOTE: these MUST be created before any policy references is_admin().
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.get_my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_roles where user_id = auth.uid()
$$;

grant execute on function public.is_admin()   to authenticated;
grant execute on function public.get_my_role() to authenticated;

-- Admin: full control over every role row (manage viewers/admins).
create policy user_roles_admin_all on public.user_roles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Everyone authenticated: read their OWN row so the UI can fetch the role.
create policy user_roles_self_read on public.user_roles
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Data tables: authenticated read, admin write
-- ---------------------------------------------------------------------------
drop policy if exists ccr_jobs_read     on public.ccr_import_jobs;
drop policy if exists ccr_raw_read      on public.ccr_raw;
drop policy if exists ccr_jobs_admin_dml on public.ccr_import_jobs;
drop policy if exists ccr_raw_admin_dml  on public.ccr_raw;

-- Viewers + admin can read whatever the active/last imports contain.
create policy ccr_jobs_read on public.ccr_import_jobs
  for select to authenticated using (true);

create policy ccr_raw_read on public.ccr_raw
  for select to authenticated using (true);

-- Defence in depth: only admin may write to data tables through RLS. (The
-- production import path uses the service role key, which bypasses RLS.)
create policy ccr_jobs_admin_dml on public.ccr_import_jobs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy ccr_raw_admin_dml on public.ccr_raw
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Explicit grants (Supabase's default privileges normally include these, but
-- be explicit so the state is reproducible on any project).
revoke all on table public.ccr_raw, public.ccr_import_jobs, public.user_roles from anon;
grant select on table public.ccr_raw, public.ccr_import_jobs to authenticated;
grant select, insert, update, delete on table public.user_roles to authenticated;

-- ---------------------------------------------------------------------------
-- Data RPCs: authenticated only
-- ---------------------------------------------------------------------------
revoke execute on function public.get_ccr_dashboard(
  date, date, text[], text[], text[], text[], text[], text[], text) from anon;
grant  execute on function public.get_ccr_dashboard(
  date, date, text[], text[], text[], text[], text[], text[], text) to authenticated;

revoke execute on function public.get_ccr_visits(
  date, date, text[], text[], text[], text[], text[], text[], text) from anon;
grant  execute on function public.get_ccr_visits(
  date, date, text[], text[], text[], text[], text[], text[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed rows — ADMIN ONLY. user_roles.user_id must match an existing auth.users
-- row (uuid below is a placeholder). Replace with the real UUIDs from
-- Dashboard -> Authentication -> Users, or run backend/scripts/provision_users.py
-- which performs both steps automatically.
-- ---------------------------------------------------------------------------
-- insert into public.user_roles (user_id, email, role) values
--   ('00000000-0000-0000-0000-000000000001', 'admin@example.com',  'admin'),
--   ('00000000-0000-0000-0000-000000000002', 'viewer1@example.com', 'viewer'),
--   ('00000000-0000-0000-0000-000000000003', 'viewer2@example.com', 'viewer'),
--   ('00000000-0000-0000-0000-000000000004', 'viewer3@example.com', 'viewer'),
--   ('00000000-0000-0000-0000-000000000005', 'viewer4@example.com', 'viewer'),
--   ('00000000-0000-0000-0000-000000000006', 'viewer5@example.com', 'viewer'),
--   ('00000000-0000-0000-0000-000000000007', 'viewer6@example.com', 'viewer'),
--   ('00000000-0000-0000-0000-000000000008', 'viewer7@example.com', 'viewer')
-- on conflict (user_id) do update set role = excluded.role;
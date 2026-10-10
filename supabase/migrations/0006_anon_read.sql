-- ============================================================================
-- 0006_anon_read.sql — public (anon) read access for the dashboard
--
-- The web login is now a local employee gate (Emp Code + shared password);
-- there is no Supabase session/JWT anymore, so the dashboard reads data with
-- the public anon key. This restores the pre-0004 behaviour: anyone with the
-- dashboard link can read the (aggregated + raw) CCR data via the two RPCs;
-- writes remain server-side only (service role / admin backend).
--
-- Paste the WHOLE file into the Supabase SQL Editor and run it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Read policies back to anon + authenticated (viewers keep reading too).
-- ---------------------------------------------------------------------------
drop policy if exists ccr_jobs_read on public.ccr_import_jobs;
create policy ccr_jobs_read on public.ccr_import_jobs
  for select to anon, authenticated using (true);

drop policy if exists ccr_raw_read on public.ccr_raw;
create policy ccr_raw_read on public.ccr_raw
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Table SELECT grants for the anon role.
-- ---------------------------------------------------------------------------
grant select on table public.ccr_import_jobs to anon;
grant select on table public.ccr_raw to anon;

-- ---------------------------------------------------------------------------
-- Data RPCs executable by anon (the two read RPCs the dashboard uses).
-- ---------------------------------------------------------------------------
grant execute on function public.get_ccr_dashboard(date, date, text[], text[], text[], text[], text[], text[], text)
  to anon, authenticated;
grant execute on function public.get_ccr_visits(date, date, text[], text[], text[], text[], text[], text[], text)
  to anon, authenticated;
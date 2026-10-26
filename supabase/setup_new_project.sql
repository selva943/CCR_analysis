-- CCR dashboard: combined SQL setup for a fresh, empty Supabase project.
-- Paste this entire file into the new project SQL Editor and run once.
-- Generated from migrations 0001 through 0007 in dependency order.
-- This creates schema/RPCs/access policies only; it does not import CCR data.
-- Keep credentials out of this file. See NEW_SUPABASE_PROJECT.md for setup.

-- ============================================================================
-- BEGIN 0001_ccr_schema.sql
-- ============================================================================
-- ============================================================================
-- 0001_ccr_schema.sql — CCR Analysis Supabase migration (Phase 1)
--
-- Design notes (see MIGRATION_ASSESSMENT):
--   * ccr_raw      : one row per source CCR visit row, EXACTLY as normalized by
--                    dashboard/js/data.js processSheet (source of truth).
--                    Invalid rows are preserved too (is_valid = false) because
--                    the browser pipeline counts them in analytics/report.
--   * ccr_import_jobs: upload/job tracking + the exact Data Quality report.
--   * No pre-aggregated summary table yet: the dashboard RPC aggregates the
--                    active import (~85k rows) in PostgreSQL in a few dozen ms.
--                    A summary table is added later only if EXPLAIN ANALYZE
--                    shows this is a bottleneck (rules §5, §25).
--   * get_ccr_dashboard(): one RPC returning the per-DSE-day accumulator rows
--                    (grain of metrics.js buildDaily) + filter options + meta.
--                    Derived scores (discipline/risk/ranking) stay in the
--                    browser on identical JS code so business logic parity is
--                    guaranteed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Import / job tracking
-- ---------------------------------------------------------------------------
create table if not exists public.ccr_import_jobs (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  file_hash     text,                       -- sha256, idempotent re-upload guard
  status        text not null default 'PENDING'
                check (status in ('PENDING','PROCESSING','COMPLETED','FAILED')),
  active        boolean not null default false,   -- the dashboard reads the active import
  total_rows    int,
  processed_rows int default 0,
  failed_rows   int default 0,
  report        jsonb,                      -- exact processSheet report object
  error_message text,
  imported_by   text,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- at most one active import
create unique index if not exists ccr_import_jobs_one_active
  on public.ccr_import_jobs (active) where active;

-- ---------------------------------------------------------------------------
-- Raw CCR visits (normalized exactly like the browser's `visit` objects)
-- ---------------------------------------------------------------------------
create table if not exists public.ccr_raw (
  id                  bigserial primary key,
  import_id           uuid not null references public.ccr_import_jobs(id) on delete cascade,
  business_date       date not null,
  date_obj            bigint,               -- epoch ms (UTC midnight); kept for parity with visit.dateObj

  branch_code         text not null default '',
  branch_location     text not null default '',
  dse_code            text not null default '',
  dse_name            text not null default '',
  zsm                 text not null default '',
  asm                 text not null default '',
  aso                 text not null default '',
  route_name          text,                     -- null when the source cell is empty (JS null)

  retailer_code       text not null default '',
  retailer_name       text not null default '',
  contact_1           text not null default '',
  contact_2           text not null default '',

  channel_name        text not null default '',
  channel             text not null default '',   -- SMALL / WS / LARGE / SELF SERVICE / SPECIALITY
  sub_channel         text not null default '',
  in_market_status    text not null default '',

  -- minutes from midnight (may be fractional), null when unparseable
  day_start_min       numeric,
  start_min           numeric,
  end_min             numeric,
  intime_min          numeric,
  duration_min        numeric,              -- null when end < start (negative)

  distance            numeric,
  order_value         numeric,
  calls_made          numeric,              -- raw "Calls Made" value (0/1/…)

  productivity        text not null default '',   -- YES / NO / UNKNOWN (normalized)
  productivity_raw    text not null default '',
  call_compliance     text,                 -- YES / NO / null
  below_5             text not null default '',   -- YES / NO / UNKNOWN
  on_route            text not null default '',   -- YES / NO / UNKNOWN (normalized)
  on_route_raw        text not null default '',
  deviation_m         numeric,              -- null when missing/negative? (kept as parsed; invalid rows flagged)
  deviation_flag      text not null default '',   -- YES / NO / UNKNOWN
  reason_for_deviation text not null default '',
  reason              text not null default '',
  remarks             text not null default '',

  latitude            numeric,
  longitude           numeric,

  visit_p1m           numeric,
  visit_p3m           numeric,
  visit_ipdp          numeric,

  is_valid            boolean not null default true,  -- processSheet isValid
  dup_key             text,                        -- processSheet dupKey (audit)
  source_file         text,
  uploaded_at         timestamptz not null default now()
);

-- Query-pattern indexes (kept deliberately small; import_id first because the
-- dashboard always scopes to the active import). Validate with EXPLAIN ANALYZE.
create index if not exists ccr_raw_import_date    on public.ccr_raw (import_id, business_date);
create index if not exists ccr_raw_import_dse     on public.ccr_raw (import_id, dse_code, business_date);
create index if not exists ccr_raw_import_branch  on public.ccr_raw (import_id, branch_location, business_date);
create index if not exists ccr_raw_import_zsm     on public.ccr_raw (import_id, zsm);
create index if not exists ccr_raw_import_asm     on public.ccr_raw (import_id, asm);
create index if not exists ccr_raw_import_aso     on public.ccr_raw (import_id, aso);
create index if not exists ccr_raw_import_channel on public.ccr_raw (import_id, channel);
create index if not exists ccr_raw_import_onroute on public.ccr_raw (import_id, on_route);

-- ---------------------------------------------------------------------------
-- Row Level Security: public read (the app has no login today — matches the
-- existing "anyone with the link can view" behaviour), writes only server-side
-- (service role bypasses RLS; no INSERT/UPDATE/DELETE policies exist).
-- ---------------------------------------------------------------------------
alter table public.ccr_import_jobs enable row level security;
alter table public.ccr_raw         enable row level security;

drop policy if exists ccr_jobs_read on public.ccr_import_jobs;
create policy ccr_jobs_read on public.ccr_import_jobs
  for select to anon, authenticated using (true);

drop policy if exists ccr_raw_read on public.ccr_raw;
create policy ccr_raw_read on public.ccr_raw
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- get_ccr_dashboard — single RPC for the dashboard fast path.
--
-- Returns jsonb:
--   {
--     "daily":  [ per-DSE-day accumulator rows, ordered like the browser's
--                 dailyMap (each group's first sheet row id asc = the order
--                 buildDaily first sees each dse|date key) ],
--     "options": { branchLocs, zsms, asms, asos, channels, dses } — same
--                 cascading semantics as app.js state.hierarchyBase(),
--     "meta":   { date_min, date_max, total_visits, report, import: {...} }
--   }
--
-- Accumulator names mirror metrics.js buildDaily so that
-- metrics.js hydrateDailyRows() + finalizeDaily() produce objects identical to
-- the browser pipeline. Thresholds 570 / 100 below are DEFAULTS from
-- metrics.js (the browser uses DEFAULTS, not the UI params, in buildDaily and
-- computeDiscipline — preserved deliberately).
-- ---------------------------------------------------------------------------
create or replace function public.get_ccr_dashboard(
  p_date_from   date    default null,
  p_date_to     date    default null,
  p_branch_locs text[]  default null,
  p_zsms        text[]  default null,
  p_asms        text[]  default null,
  p_asos        text[]  default null,
  p_dse_codes   text[]  default null,
  p_channels    text[]  default null,
  p_on_route    text    default 'ALL'
)
returns jsonb
language sql
stable
as $$
with active as (
  select id, file_name, completed_at, total_rows, report
  from public.ccr_import_jobs
  where active and status = 'COMPLETED'
  order by completed_at desc
  limit 1
),
-- All rows of the active import (unfiltered): drives meta (JS setDefaults uses
-- dates from the full visit set, not the current filters).
import_rows as (
  select r.*
  from public.ccr_raw r
  where r.import_id = (select id from active)
),
-- Filter options must mirror app.js state.hierarchyBase(), which applies every
-- filter EXCEPT dseCodes and onRoute (those never scope the dropdowns).
opt_base as (
  select * from import_rows
  where (p_date_from is null or business_date >= p_date_from)
    and (p_date_to   is null or business_date <= p_date_to)
    and (p_branch_locs is null or cardinality(p_branch_locs) = 0
         or branch_location = any(p_branch_locs))
    and (p_zsms is null or cardinality(p_zsms) = 0 or zsm = any(p_zsms))
    and (p_asms is null or cardinality(p_asms) = 0 or asm = any(p_asms))
    and (p_asos is null or cardinality(p_asos) = 0 or aso = any(p_asos))
    and (p_channels is null or cardinality(p_channels) = 0
         or channel = any(p_channels))
),
base as (
  select * from import_rows
  where (p_date_from is null or business_date >= p_date_from)
    and (p_date_to   is null or business_date <= p_date_to)
    and (p_branch_locs is null or cardinality(p_branch_locs) = 0
         or branch_location = any(p_branch_locs))
    and (p_zsms is null or cardinality(p_zsms) = 0 or zsm = any(p_zsms))
    and (p_asms is null or cardinality(p_asms) = 0 or asm = any(p_asms))
    and (p_asos is null or cardinality(p_asos) = 0 or aso = any(p_asos))
    and (p_dse_codes is null or cardinality(p_dse_codes) = 0
         or dse_code = any(p_dse_codes))
    and (p_channels is null or cardinality(p_channels) = 0
         or channel = any(p_channels))
    and (p_on_route is null or p_on_route = 'ALL' or on_route = p_on_route)
),
-- first row of each DSE-day (min id within the group = the row the browser's
-- buildDaily sees first when iterating visits in sheet order)
first_rows as (
  select distinct on (dse_code, business_date)
         dse_code, business_date,
         day_start_min as first_row_day_start,
         dse_name, branch_code, branch_location, zsm, asm, aso, id
  from base
  order by dse_code, business_date, id
),
-- earliest-start visit of each DSE-day (browser sort: start_min asc nulls last,
-- stable → sheet id asc for ties)
first_visits as (
  select distinct on (dse_code, business_date)
         dse_code, business_date,
         start_min   as first_start_min,
         on_route    as first_on_route,
         deviation_m as first_dev_m
  from base
  order by dse_code, business_date, start_min asc nulls last, id asc
),
agg as (
  select
    r.dse_code,
    r.business_date,
    count(*)                                              as visits,
    count(*) filter (where r.calls_made = 1)              as calls_made,
    count(*) filter (where r.below_5 = 'YES')             as below5,
    count(*) filter (where r.productivity = 'YES')        as prod_calls,
    count(*) filter (where r.productivity = 'YES'
                       and r.on_route = 'YES')            as prod_on_route,
    count(*) filter (where r.productivity = 'YES'
                       and r.on_route = 'NO')             as off_route_prod_yes,
    count(*) filter (where r.on_route <> 'UNKNOWN')       as on_route_valid,
    count(*) filter (where r.on_route = 'YES')            as on_route_yes,
    count(*) filter (where r.on_route = 'NO')             as off_route_yes,
    count(*) filter (where r.on_route = 'YES'
                       and r.deviation_m is not null
                       and r.deviation_m <= 100)          as on_route_dev_pass,
    count(*) filter (where r.deviation_m is not null)     as dev_valid,
    count(*) filter (where r.deviation_m is not null
                       and r.deviation_m <= 100)          as dev_pass,
    coalesce(sum(r.deviation_m)
               filter (where r.deviation_m is not null), 0) as dev_sum,
    max(r.deviation_m) filter (where r.deviation_m is not null) as dev_max,
    count(*) filter (where r.deviation_m is not null
                       and r.deviation_m > 100)           as high_dev,
    count(*) filter (where r.call_compliance is not null) as call_comp_valid,
    count(*) filter (where r.call_compliance = 'YES')     as call_comp_yes,
    coalesce(sum(r.order_value)
               filter (where r.order_value is not null), 0) as order_sum,
    count(*) filter (where r.order_value is not null)     as order_count,
    coalesce(sum(r.duration_min)
               filter (where r.duration_min is not null
                         and r.duration_min >= 0), 0)     as store_min,
    count(*) filter (where r.duration_min is not null
                       and r.duration_min >= 0)           as store_count,
    percentile_cont(0.5) within group (
      order by r.duration_min
    ) filter (where r.duration_min is not null
                and r.duration_min >= 0)                  as store_median,
    coalesce(sum(r.intime_min)
               filter (where r.intime_min is not null), 0) as intime_sum,
    count(*) filter (where r.intime_min is not null)      as intime_count,
    min(r.start_min)                                      as min_start,
    max(r.end_min)                                        as max_end
  from base r
  group by r.dse_code, r.business_date
)
select jsonb_build_object(
  'daily', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'dse_code',            fr.dse_code,
      'date',                to_char(fr.business_date, 'YYYY-MM-DD'),
      'dse_name',            fr.dse_name,
      'branch_code',         fr.branch_code,
      'branch_location',     fr.branch_location,
      'zsm',                 fr.zsm,
      'asm',                 fr.asm,
      'aso',                 fr.aso,
      'visits',              a.visits,
      'callsMade',           a.calls_made,
      'below5',              a.below5,
      'prodCalls',           a.prod_calls,
      'prodOnRoute',         a.prod_on_route,
      'offRouteProdYes',     a.off_route_prod_yes,
      'onRouteValid',        a.on_route_valid,
      'onRouteYes',          a.on_route_yes,
      'offRouteYes',         a.off_route_yes,
      'onRouteDevPass',      a.on_route_dev_pass,
      'devValid',            a.dev_valid,
      'devPass',             a.dev_pass,
      'devSum',              a.dev_sum,
      'devMax',              a.dev_max,
      'highDev',             a.high_dev,
      'callCompValid',       a.call_comp_valid,
      'callCompYes',         a.call_comp_yes,
      'orderSum',            a.order_sum,
      'orderCount',          a.order_count,
      'storeMin',            a.store_min,
      'storeCount',          a.store_count,
      'storeMedian',         a.store_median,
      'intimeSum',           a.intime_sum,
      'intimeCount',         a.intime_count,
      'minStart',            a.min_start,
      'maxEnd',              a.max_end,
      'firstRowDayStart',    fr.first_row_day_start,
      'firstStartMin',       fv.first_start_min,
      'firstOnRoute',        fv.first_on_route,
      'firstDevM',           fv.first_dev_m
    ) order by fr.id), '[]'::jsonb)
    from first_rows fr
    join agg       a on a.dse_code = fr.dse_code and a.business_date = fr.business_date
    left join first_visits fv on fv.dse_code = fr.dse_code and fv.business_date = fr.business_date
  ),
  'options', jsonb_build_object(
    'branchLocs', (select coalesce(jsonb_agg(distinct branch_location), '[]'::jsonb) from opt_base),
    'zsms',       (select coalesce(jsonb_agg(distinct zsm), '[]'::jsonb) from opt_base),
    'asms',       (select coalesce(jsonb_agg(distinct asm), '[]'::jsonb) from opt_base),
    'asos',       (select coalesce(jsonb_agg(distinct aso), '[]'::jsonb) from opt_base),
    'channels',   (select coalesce(jsonb_agg(distinct channel), '[]'::jsonb)
                     from opt_base where channel <> 'SPECIALITY'),
    'dses',       (select coalesce(jsonb_agg(jsonb_build_object(
                                 'dse_code', t.dse_code, 'dse_name', t.dse_name)),
                                    '[]'::jsonb)
                     from (select distinct on (dse_code) dse_code, dse_name
                             from opt_base order by dse_code, business_date, id) t)
  ),
  'meta', jsonb_build_object(
    'date_min',     (select to_char(min(business_date), 'YYYY-MM-DD') from import_rows),
    'date_max',     (select to_char(max(business_date), 'YYYY-MM-DD') from import_rows),
    'total_visits', (select count(*) from import_rows),
    'has_data',     (select count(*) > 0 from active),
    'report',       (select report from active),
    'import',       (select jsonb_build_object(
                              'id', id,
                              'file_name', file_name,
                              'completed_at', completed_at,
                              'total_rows', total_rows)
                       from active)
  )
);
$$;

grant execute on function public.get_ccr_dashboard(date, date, text[], text[], text[], text[], text[], text[], text)
  to anon, authenticated;

-- ============================================================================
-- END 0001_ccr_schema.sql
-- ============================================================================

-- ============================================================================
-- BEGIN 0002_ccr_perf.sql
-- ============================================================================
-- ============================================================================
-- 0002_ccr_rpc.sql — performance + row-level visits RPC
--
-- Paste this WHOLE file into the Supabase SQL Editor and run it.
--
-- 1) Raises the API statement timeout: on the 173k-row import the original
--    get_ccr_dashboard exceeded PostgREST's statement timeout (~3s):
--      * import_rows materialized all 46 columns, read 5x per call (~250MB)
--      * jsonb_agg(distinct ...) converted 173k values to jsonb per option
--      * meta min/max/count scanned the wide CTE instead of the
--        (import_id, business_date) index
--
-- 2) get_ccr_dashboard v2 — same signature, same JSON contract, narrow
--    materialized CTEs, cheap option aggregation, index-driven meta.
--
-- 3) get_ccr_visits is installed separately by 0003_visits_json.sql. Keeping
--    its definition out of this migration lets 0002 be safely re-run after
--    0003 has changed the function's return type from jsonb to json.
-- ============================================================================

-- API statement timeout (PostgREST runs as authenticator -> SET ROLE anon /
-- authenticated; role settings apply when the role is activated).
alter role anon          set statement_timeout = '60s';
alter role authenticated set statement_timeout = '60s';
alter role authenticator set statement_timeout = '60s';

-- Recycle idle API connections so they pick up the new timeout immediately
-- (in-flight queries are untouched; PostgREST reconnects transparently).
select pg_terminate_backend(pid)
from pg_stat_activity
where usename = 'authenticator'
  and state = 'idle'
  and pid <> pg_backend_pid();

-- ---------------------------------------------------------------------------
-- get_ccr_dashboard v2
-- ---------------------------------------------------------------------------
create or replace function public.get_ccr_dashboard(
  p_date_from   date    default null,
  p_date_to     date    default null,
  p_branch_locs text[]  default null,
  p_zsms        text[]  default null,
  p_asms        text[]  default null,
  p_asos        text[]  default null,
  p_dse_codes   text[]  default null,
  p_channels    text[]  default null,
  p_on_route    text    default 'ALL'
)
returns jsonb
language sql
stable
as $$
with active as (
  select id, file_name, completed_at, total_rows, report
  from public.ccr_import_jobs
  where active and status = 'COMPLETED'
  order by completed_at desc
  limit 1
),
-- Narrow projection: only the columns the daily aggregate / first-row /
-- first-visit rules actually read. Filters = full JS filter set.
base as materialized (
  select r.id, r.business_date, r.dse_code, r.dse_name, r.branch_code,
         r.branch_location, r.zsm, r.asm, r.aso,
         r.day_start_min, r.start_min, r.end_min, r.intime_min, r.duration_min,
         r.calls_made, r.below_5, r.productivity, r.on_route,
         r.deviation_m, r.call_compliance, r.order_value
  from public.ccr_raw r
  where r.import_id = (select id from active)
    and (p_date_from is null or r.business_date >= p_date_from)
    and (p_date_to   is null or r.business_date <= p_date_to)
    and (p_branch_locs is null or cardinality(p_branch_locs) = 0
         or r.branch_location = any(p_branch_locs))
    and (p_zsms is null or cardinality(p_zsms) = 0 or r.zsm = any(p_zsms))
    and (p_asms is null or cardinality(p_asms) = 0 or r.asm = any(p_asms))
    and (p_asos is null or cardinality(p_asos) = 0 or r.aso = any(p_asos))
    and (p_dse_codes is null or cardinality(p_dse_codes) = 0
         or r.dse_code = any(p_dse_codes))
    and (p_channels is null or cardinality(p_channels) = 0
         or r.channel = any(p_channels))
    and (p_on_route is null or p_on_route = 'ALL' or r.on_route = p_on_route)
),
-- Dropdown options: everything EXCEPT dseCodes/onRoute (app.js hierarchyBase).
opt as materialized (
  select r.id, r.business_date, r.branch_location, r.zsm, r.asm, r.aso,
         r.channel, r.dse_code, r.dse_name
  from public.ccr_raw r
  where r.import_id = (select id from active)
    and (p_date_from is null or r.business_date >= p_date_from)
    and (p_date_to   is null or r.business_date <= p_date_to)
    and (p_branch_locs is null or cardinality(p_branch_locs) = 0
         or r.branch_location = any(p_branch_locs))
    and (p_zsms is null or cardinality(p_zsms) = 0 or r.zsm = any(p_zsms))
    and (p_asms is null or cardinality(p_asms) = 0 or r.asm = any(p_asms))
    and (p_asos is null or cardinality(p_asos) = 0 or r.aso = any(p_asos))
    and (p_channels is null or cardinality(p_channels) = 0
         or r.channel = any(p_channels))
),
-- First sheet row of each DSE-day (min id = the row buildDaily sees first).
first_rows as (
  select distinct on (dse_code, business_date)
         dse_code, business_date,
         day_start_min as first_row_day_start,
         dse_name, branch_code, branch_location, zsm, asm, aso, id
  from base
  order by dse_code, business_date, id
),
-- Earliest-start visit of each DSE-day (start_min asc nulls last, id asc).
first_visits as (
  select distinct on (dse_code, business_date)
         dse_code, business_date,
         start_min   as first_start_min,
         on_route    as first_on_route,
         deviation_m as first_dev_m
  from base
  order by dse_code, business_date, start_min asc nulls last, id asc
),
agg as (
  select
    r.dse_code,
    r.business_date,
    count(*)                                              as visits,
    count(*) filter (where r.calls_made = 1)              as calls_made,
    count(*) filter (where r.below_5 = 'YES')             as below5,
    count(*) filter (where r.productivity = 'YES')        as prod_calls,
    count(*) filter (where r.productivity = 'YES'
                       and r.on_route = 'YES')            as prod_on_route,
    count(*) filter (where r.productivity = 'YES'
                       and r.on_route = 'NO')             as off_route_prod_yes,
    count(*) filter (where r.on_route <> 'UNKNOWN')       as on_route_valid,
    count(*) filter (where r.on_route = 'YES')            as on_route_yes,
    count(*) filter (where r.on_route = 'NO')             as off_route_yes,
    count(*) filter (where r.on_route = 'YES'
                       and r.deviation_m is not null
                       and r.deviation_m <= 100)          as on_route_dev_pass,
    count(*) filter (where r.deviation_m is not null)     as dev_valid,
    count(*) filter (where r.deviation_m is not null
                       and r.deviation_m <= 100)          as dev_pass,
    coalesce(sum(r.deviation_m)
               filter (where r.deviation_m is not null), 0) as dev_sum,
    max(r.deviation_m) filter (where r.deviation_m is not null) as dev_max,
    count(*) filter (where r.deviation_m is not null
                       and r.deviation_m > 100)           as high_dev,
    count(*) filter (where r.call_compliance is not null) as call_comp_valid,
    count(*) filter (where r.call_compliance = 'YES')     as call_comp_yes,
    coalesce(sum(r.order_value)
               filter (where r.order_value is not null), 0) as order_sum,
    count(*) filter (where r.order_value is not null)     as order_count,
    coalesce(sum(r.duration_min)
               filter (where r.duration_min is not null
                         and r.duration_min >= 0), 0)     as store_min,
    count(*) filter (where r.duration_min is not null
                       and r.duration_min >= 0)           as store_count,
    percentile_cont(0.5) within group (
      order by r.duration_min
    ) filter (where r.duration_min is not null
                and r.duration_min >= 0)                  as store_median,
    coalesce(sum(r.intime_min)
               filter (where r.intime_min is not null), 0) as intime_sum,
    count(*) filter (where r.intime_min is not null)      as intime_count,
    min(r.start_min)                                      as min_start,
    max(r.end_min)                                        as max_end
  from base r
  group by r.dse_code, r.business_date
)
select jsonb_build_object(
  'daily', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'dse_code',            fr.dse_code,
      'date',                to_char(fr.business_date, 'YYYY-MM-DD'),
      'dse_name',            fr.dse_name,
      'branch_code',         fr.branch_code,
      'branch_location',     fr.branch_location,
      'zsm',                 fr.zsm,
      'asm',                 fr.asm,
      'aso',                 fr.aso,
      'visits',              a.visits,
      'callsMade',           a.calls_made,
      'below5',              a.below5,
      'prodCalls',           a.prod_calls,
      'prodOnRoute',         a.prod_on_route,
      'offRouteProdYes',     a.off_route_prod_yes,
      'onRouteValid',        a.on_route_valid,
      'onRouteYes',          a.on_route_yes,
      'offRouteYes',         a.off_route_yes,
      'onRouteDevPass',      a.on_route_dev_pass,
      'devValid',            a.dev_valid,
      'devPass',             a.dev_pass,
      'devSum',              a.dev_sum,
      'devMax',              a.dev_max,
      'highDev',             a.high_dev,
      'callCompValid',       a.call_comp_valid,
      'callCompYes',         a.call_comp_yes,
      'orderSum',            a.order_sum,
      'orderCount',          a.order_count,
      'storeMin',            a.store_min,
      'storeCount',          a.store_count,
      'storeMedian',         a.store_median,
      'intimeSum',           a.intime_sum,
      'intimeCount',         a.intime_count,
      'minStart',            a.min_start,
      'maxEnd',              a.max_end,
      'firstRowDayStart',    fr.first_row_day_start,
      'firstStartMin',       fv.first_start_min,
      'firstOnRoute',        fv.first_on_route,
      'firstDevM',           fv.first_dev_m
    ) order by fr.id), '[]'::jsonb)
    from first_rows fr
    join agg       a on a.dse_code = fr.dse_code and a.business_date = fr.business_date
    left join first_visits fv on fv.dse_code = fr.dse_code and fv.business_date = fr.business_date
  ),
  'options', jsonb_build_object(
    -- distinct text first (hash agg), jsonb conversion only over the small
    -- unique result. Display order is applied in ui.js (localeCompare).
    'branchLocs', (select coalesce(jsonb_agg(x), '[]'::jsonb)
                     from (select distinct branch_location as x from opt) s),
    'zsms',       (select coalesce(jsonb_agg(x), '[]'::jsonb)
                     from (select distinct zsm as x from opt) s),
    'asms',       (select coalesce(jsonb_agg(x), '[]'::jsonb)
                     from (select distinct asm as x from opt) s),
    'asos',       (select coalesce(jsonb_agg(x), '[]'::jsonb)
                     from (select distinct aso as x from opt) s),
    'channels',   (select coalesce(jsonb_agg(x), '[]'::jsonb)
                     from (select distinct channel as x
                             from opt where channel <> 'SPECIALITY') s),
    -- JS: Map keyed by dse_code, first occurrence in sheet order (min id)
    -- keeps the first-seen dse_name. Order irrelevant (sorted at render).
    'dses',       (select coalesce(jsonb_agg(jsonb_build_object(
                                 'dse_code', t.dse_code, 'dse_name', t.dse_name)
                                 order by t.id), '[]'::jsonb)
                     from (select distinct on (dse_code)
                                  dse_code, dse_name, id
                             from opt order by dse_code, id) t)
  ),
  'meta', jsonb_build_object(
    -- min/max/count straight off the (import_id, business_date) index.
    'date_min',     (select to_char(min(business_date), 'YYYY-MM-DD')
                       from public.ccr_raw
                      where import_id = (select id from active)),
    'date_max',     (select to_char(max(business_date), 'YYYY-MM-DD')
                       from public.ccr_raw
                      where import_id = (select id from active)),
    'total_visits', (select count(*) from public.ccr_raw
                      where import_id = (select id from active)),
    'has_data',     (select count(*) > 0 from active),
    'report',       (select report from active),
    'import',       (select jsonb_build_object(
                              'id', id,
                              'file_name', file_name,
                              'completed_at', completed_at,
                              'total_rows', total_rows)
                       from active)
  )
);
$$;

grant execute on function public.get_ccr_dashboard(date, date, text[], text[], text[], text[], text[], text[], text)
  to anon, authenticated;

-- ============================================================================
-- END 0002_ccr_perf.sql
-- ============================================================================

-- ============================================================================
-- BEGIN 0003_visits_json.sql
-- ============================================================================
-- 0003: get_ccr_visits jsonb -> json (Phase 4/5 perf fix)
--
-- Measured on the live project (MTD CCR 25.08.xlsx, 173,832 rows):
--   1-day slice   (8.5k rows,  8.8 MB):  server TTFB 3.4s  -> 0.39 ms/row
--   4-day slice   (33k rows,  34.6 MB):  server TTFB 16.2s -> 0.49 ms/row
--   full dataset  (173k rows, ~188 MB):  projected ~80s -> exceeds both the
--     60s statement timeout and the API gateway's ~40s limit (Cloudflare 520).
--
-- The query itself is a plain index range scan; the cost is per-row JSONB
-- construction: jsonb_build_object makes a key-sorted binary object (~6us per
-- key x 41 keys/row = ~250us/row), and PostgREST must then walk the whole
-- jsonb tree again to serialize the response.
--
-- Plain json (json_agg / json_build_object) builds the response by text
-- concatenation (~1us/key) and is streamed to PostgREST as-is -- no tree
-- re-walk, no key sorting. Expected ~10x faster; byte-identical JSON
-- semantics (same to_json output functions), verified by tests/parity_live.js.
--
-- Return type changes cannot use create or replace -> drop + create + grant.
-- Signature (name, arg names, arg types) is unchanged: ccrService's rpcParams
-- keeps sending p_date_from / p_date_to / ... as before.

drop function if exists public.get_ccr_visits(date, date, text[], text[], text[], text[], text[], text[], text);

create function public.get_ccr_visits(
  p_date_from   date    default null,
  p_date_to     date    default null,
  p_branch_locs text[]  default null,
  p_zsms        text[]  default null,
  p_asms        text[]  default null,
  p_asos        text[]  default null,
  p_dse_codes   text[]  default null,
  p_channels    text[]  default null,
  p_on_route    text    default 'ALL'
)
returns json
language sql
stable
as $$
with active as (
  select id from public.ccr_import_jobs
  where active and status = 'COMPLETED'
  order by completed_at desc
  limit 1
)
select coalesce(
  (select json_agg(
            json_build_object(
              'date',                to_char(r.business_date, 'YYYY-MM-DD'),
              'dateObj',             r.date_obj,
              'branch_code',         r.branch_code,
              'branch_location',     r.branch_location,
              'dse_code',            r.dse_code,
              'dse_name',            r.dse_name,
              'zsm',                 r.zsm,
              'asm',                 r.asm,
              'aso',                 r.aso,
              'route_name',          r.route_name,
              'retailer_code',       r.retailer_code,
              'retailer_name',       r.retailer_name,
              'contact_1',           r.contact_1,
              'contact_2',           r.contact_2,
              'channel_name',        r.channel_name,
              'channel',             r.channel,
              'sub_channel',         r.sub_channel,
              'in_market_status',    r.in_market_status,
              'day_start_min',       r.day_start_min,
              'start_min',           r.start_min,
              'end_min',             r.end_min,
              'intime_min',          r.intime_min,
              'duration_min',        r.duration_min,
              'distance',            r.distance,
              'order_value',         r.order_value,
              'calls_made',          r.calls_made,
              'productivity',        r.productivity,
              'productivity_raw',    r.productivity_raw,
              'call_compliance',     r.call_compliance,
              'below_5',             r.below_5,
              'on_route',            r.on_route,
              'on_route_raw',        r.on_route_raw,
              'deviation_m',         r.deviation_m,
              'deviation_flag',      r.deviation_flag,
              'reason_for_deviation', r.reason_for_deviation,
              'reason',              r.reason,
              'remarks',             r.remarks,
              'latitude',            r.latitude,
              'longitude',           r.longitude,
              'visit_p1m',           r.visit_p1m,
              'visit_p3m',           r.visit_p3m,
              'visit_ipdp',          r.visit_ipdp
            )
            order by r.business_date, r.id)
     from public.ccr_raw r
     where r.import_id = (select id from active)
       and (p_date_from is null or r.business_date >= p_date_from)
       and (p_date_to   is null or r.business_date <= p_date_to)
       and (p_branch_locs is null or cardinality(p_branch_locs) = 0
            or r.branch_location = any(p_branch_locs))
       and (p_zsms is null or cardinality(p_zsms) = 0 or r.zsm = any(p_zsms))
       and (p_asms is null or cardinality(p_asms) = 0 or r.asm = any(p_asms))
       and (p_asos is null or cardinality(p_asos) = 0 or r.aso = any(p_asos))
       and (p_dse_codes is null or cardinality(p_dse_codes) = 0
            or r.dse_code = any(p_dse_codes))
       and (p_channels is null or cardinality(p_channels) = 0
            or r.channel = any(p_channels))
       and (p_on_route is null or p_on_route = 'ALL' or r.on_route = p_on_route)),
  '[]'::json);
$$;

grant execute on function public.get_ccr_visits(date, date, text[], text[], text[], text[], text[], text[], text)
  to anon, authenticated;

-- ============================================================================
-- END 0003_visits_json.sql
-- ============================================================================

-- ============================================================================
-- BEGIN 0004_auth.sql
-- ============================================================================
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
-- ============================================================================
-- END 0004_auth.sql
-- ============================================================================

-- ============================================================================
-- BEGIN 0005_access_log.sql
-- ============================================================================
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

-- ============================================================================
-- END 0005_access_log.sql
-- ============================================================================

-- ============================================================================
-- BEGIN 0006_anon_read.sql
-- ============================================================================
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
-- ============================================================================
-- END 0006_anon_read.sql
-- ============================================================================

-- ============================================================================
-- BEGIN 0007_access_log_local.sql
-- ============================================================================
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
-- ============================================================================
-- END 0007_access_log_local.sql
-- ============================================================================

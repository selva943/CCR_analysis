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

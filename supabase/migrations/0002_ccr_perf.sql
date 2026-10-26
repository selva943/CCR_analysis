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

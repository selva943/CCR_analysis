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

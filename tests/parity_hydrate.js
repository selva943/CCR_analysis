// Supabase-path parity: emulate the get_ccr_daily RPC row shape from the
// (already parity-proven) Python visits, hydrate with metrics.js
// hydrateDailyRows(), then run the exact supabase-mode pipeline:
//   hydrateDailyRows -> buildDSE -> computeBenchmarks(null visits)
//   -> risk -> ranking -> computeDisciplineFromDaily -> applyDiscipline
//   -> computeProductivity(null visits) -> insight engine (on rows)
// and require an exact match against the JS golden snapshot.
//
// This validates: hydrate field mapping, the first-row / first-visit rules the
// SQL uses (day_start_min from the first sheet row; discipline fields from the
// earliest-start visit), daily ordering (group first-appearance = min id), the
// dailyMap-derived discipline/productivity branches, and that no RPC key the
// client needs is missing.
// Run: node parity_hydrate.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = 'G:\\Selva\\CCR_analysis';
global.window = global;
require(path.join(ROOT, 'dashboard', 'js', 'data.js'));
require(path.join(ROOT, 'dashboard', 'js', 'metrics.js'));
require(path.join(ROOT, 'dashboard', 'js', 'charts.js'));
require(path.join(ROOT, 'dashboard', 'js', 'insightEngine.js'));
require(path.join(ROOT, 'dashboard', 'js', 'recommendations.js'));
const NS = global.DSE;
const M = NS.metrics;

const DIR = __dirname;
const visits = JSON.parse(fs.readFileSync(path.join(DIR, 'visits_py.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(DIR, 'report_py.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'golden_ref.json'), 'utf8'));
const ref = golden.snapshot;

// ---------------------------------------------------------------------------
// Reference pipeline (xlsx mode): buildDaily over the proven visits.
// ---------------------------------------------------------------------------
const refMap = M.buildDaily(visits);

// ---------------------------------------------------------------------------
// 1) Group visits exactly like SQL does (sheet order = row id asc).
// ---------------------------------------------------------------------------
const groups = new Map(); // key -> { rows: [] }  (insertion order = min id)
for (const v of visits) {
  const key = v.dse_code + '|' + v.date;
  let g = groups.get(key);
  if (!g) { g = { rows: [] }; groups.set(key, g); }
  g.rows.push(v);
}

// ---------------------------------------------------------------------------
// 2) Build RPC rows with EXACTLY the keys get_ccr_dashboard emits.
//    - aggregates: taken from the reference daily (SQL agg is a line-by-line
//      translation of buildDaily, reviewed separately; live SQL is checked in
//      Phase 4 against this same snapshot)
//    - identity + firstRowDayStart: from the FIRST sheet row of the group
//      (SQL distinct on ... order by dse_code, business_date, id)
//    - firstStartMin/firstOnRoute/firstDevM: from the earliest-start visit
//      (SQL distinct on ... order by start_min asc nulls last, id asc)
// ---------------------------------------------------------------------------
const RPC_KEYS = [
  'dse_code', 'date', 'dse_name', 'branch_code', 'branch_location', 'zsm', 'asm', 'aso',
  'visits', 'callsMade', 'below5', 'prodCalls', 'prodOnRoute', 'offRouteProdYes',
  'onRouteValid', 'onRouteYes', 'offRouteYes', 'onRouteDevPass',
  'devValid', 'devPass', 'devSum', 'devMax', 'highDev',
  'callCompValid', 'callCompYes', 'orderSum', 'orderCount',
  'storeMin', 'storeCount', 'storeMedian', 'intimeSum', 'intimeCount',
  'minStart', 'maxEnd',
  'firstRowDayStart', 'firstStartMin', 'firstOnRoute', 'firstDevM'
];

const rpcRows = [];
for (const [key, g] of groups) {
  const firstRow = g.rows[0];
  const d = refMap.get(key);
  if (!d) { console.log('FATAL: no reference daily for', key); process.exit(1); }
  const earliest = [...g.rows].sort((a, b) =>
    (a.start_min === null ? Infinity : a.start_min) - (b.start_min === null ? Infinity : b.start_min));
  const fv = earliest[0];
  const row = {};
  for (const k of RPC_KEYS) {
    switch (k) {
      case 'dse_name': row[k] = firstRow.dse_name; break;
      case 'branch_code': row[k] = firstRow.branch_code; break;
      case 'branch_location': row[k] = firstRow.branch_location; break;
      case 'zsm': row[k] = firstRow.zsm; break;
      case 'asm': row[k] = firstRow.asm; break;
      case 'aso': row[k] = firstRow.aso; break;
      case 'firstRowDayStart': row[k] = firstRow.day_start_min; break;
      case 'firstStartMin': row[k] = fv.start_min; break;
      case 'firstOnRoute': row[k] = fv.on_route; break;
      case 'firstDevM': row[k] = fv.deviation_m; break;
      default: row[k] = d[k]; break; // aggregates + dse_code + date + storeMedian
    }
  }
  rpcRows.push(row);
}
void RPC_KEYS;

// ---------------------------------------------------------------------------
// 3) Hydrate (this is what app.js computeSupabase does).
// ---------------------------------------------------------------------------
const hydrated = M.hydrateDailyRows(rpcRows);

let errors = 0;
function fail(m) { if (errors < 40) console.log('MISMATCH:', m); errors++; }

// ---------------------------------------------------------------------------
// 4a) dailyMap field-level compare vs reference buildDaily, in order.
// ---------------------------------------------------------------------------
const refKeys = [...refMap.keys()];
const hydKeys = [...hydrated.keys()];
if (refKeys.length !== hydKeys.length) fail(`dailyMap size: ${refKeys.length} vs ${hydKeys.length}`);
for (let i = 0; i < Math.min(refKeys.length, hydKeys.length); i++) {
  if (refKeys[i] !== hydKeys[i]) fail(`dailyMap order at ${i}: ${refKeys[i]} vs ${hydKeys[i]}`);
}
const SKIP = new Set(['retailers', 'routes', 'storeDurations']); // Set/array details not carried by RPC
for (const key of refKeys) {
  const a = refMap.get(key), b = hydrated.get(key);
  if (!b) { fail(`missing hydrated daily ${key}`); continue; }
  for (const k of Object.keys(a)) {
    if (SKIP.has(k)) continue;
    if (!(k in b)) { fail(`daily ${key}: hydrated missing ${k}`); continue; }
    const x = a[k], y = b[k];
    if (typeof x === 'number' && typeof y === 'number') {
      const tol = Math.max(1e-9, 1e-12 * Math.max(Math.abs(x), Math.abs(y)));
      if (!(Math.abs(x - y) <= tol)) fail(`daily ${key}.${k}: ${x} vs ${y}`);
    } else if (x !== y) fail(`daily ${key}.${k}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  }
  // storeMedian: ref computed from storeDurations, hydrated from RPC value —
  // the RPC value IS ref's median (SQL percentile_cont ≡ JS median); here the
  // emulated row carries ref's value, so require equality.
  if (a.storeMedian !== b.storeMedian) fail(`daily ${key}.storeMedian: ${a.storeMedian} vs ${b.storeMedian}`);
}

// ---------------------------------------------------------------------------
// 4b) Full supabase-mode pipeline vs golden snapshot.
// ---------------------------------------------------------------------------
const ds = M.buildDSE(hydrated);
const team = M.computeBenchmarks(ds, null, hydrated);
M.computeRisk(ds, team);
M.computeRanking(ds, team);
const discipline = M.computeDisciplineFromDaily(hydrated);
const discSummary = M.applyDiscipline(ds, discipline);
const prod = M.computeProductivity(null, hydrated, Object.assign({}, M.DEFAULTS));

const state = {
  allVisits: visits, filteredVisits: visits,
  dailyMap: hydrated, dseList: ds, team,
  discipline, params: Object.assign({}, M.DEFAULTS),
  drill: { zsm: null, asm: null, aso: null },
  filters: { dateFrom: null, dateTo: null, branchLocs: [], zsms: [], asms: [], asos: [], dseCodes: [], channels: [], onRoute: 'ALL' }
};
const er = NS.insightEngine.run(state);
er.recommendations = NS.recommendations.generate(state, er);

// Fields the RPC does not carry: visit-level details (retailers/routes/
// storeDurations — write-only, nothing downstream reads them) and the 4 RPC
// metadata keys (firstRowDayStart/firstStartMin/firstOnRoute/firstDevM — they
// feed computeDisciplineFromDaily, checked via the discipline compare).
const DROP = new Set(['retailers', 'routes', 'storeDurations',
  'firstRowDayStart', 'firstStartMin', 'firstOnRoute', 'firstDevM']);
function stripDaily(d) {
  const o = {};
  for (const k of Object.keys(d)) if (!DROP.has(k)) o[k] = d[k];
  return o;
}
const snap = {
  report,
  daily: [...hydrated.values()].map(stripDaily),
  dseList: ds,
  team,
  discSummary,
  productivity: prod,
  discipline: { byDse: [...discipline.byDse.entries()], byDate: [...discipline.byDate.entries()] },
  engine: { breakCount: (er.breaks || []).length, insightCount: (er.insights || []).length, recCount: (er.recommendations || []).length, breaks: (er.breaks || []).map(b => ({ id: b.id, dse: b.dseCode || b.dse_code || b.dse || null, type: b.type || b.key || null, sev: b.severity || null, title: b.title || null })) }
};

const snapN = JSON.parse(JSON.stringify(snap));
const ALLOWED_NEW = new Set(['offRouteProdYes']);

function cmp(a, b, p) {
  if (errors > 300) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { fail(`${p}: length ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) cmp(a[i], b[i], `${p}[${i}]`);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    const extra = ka.filter(k => !kb.includes(k));
    const missing = kb.filter(k => !ka.includes(k));
    if (missing.length) fail(`${p}: missing keys ${missing}`);
    if (extra.some(k => !ALLOWED_NEW.has(k))) fail(`${p}: unexpected extra keys ${extra.filter(k => !ALLOWED_NEW.has(k))}`);
    for (const k of ka) if (kb.includes(k)) cmp(a[k], b[k], `${p}.${k}`);
    return;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    const tol = Math.max(1e-9, 1e-12 * Math.max(Math.abs(a), Math.abs(b)));
    if (!(Math.abs(a - b) <= tol)) fail(`${p}: ${a} vs ${b}`);
    return;
  }
  if (a !== b) fail(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}
cmp(snapN, { ...ref, daily: ref.daily.map(stripDaily) }, 'snapshot');

if (errors === 0) {
  console.log('HYDRATE PARITY OK — RPC row shape -> hydrateDailyRows -> supabase pipeline',
    'matches golden (daily order, first-row/first-visit rules, daily-derived discipline/productivity)');
  process.exit(0);
} else {
  console.log('FAILED with', errors, 'mismatches');
  process.exit(1);
}

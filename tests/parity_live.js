// LIVE Phase-4 parity: fetches get_ccr_dashboard + get_ccr_visits from the
// real Supabase project and requires them to match the local (proven) pipeline
// on MTD CCR 25.08.xlsx exactly:
//
//   visits RPC  == tests/out2508/visits_py.json  (count, order, every field)
//   dash  RPC   == emulated RPC rows from the same visits (parity_hydrate §2)
//                  + options as sets vs JS hierarchyBase + meta/report
//   hydrate(live daily) -> supabase pipeline == reference xlsx pipeline
//                          (buildDaily -> buildDSE -> ... -> engine snapshot)
//
// Optional: if tests/visits_api.json exists (FastAPI /api/visits fallback
// dump), field-compare it against visits_py.json too.
//
// Run: node parity_live.js
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

const cfgSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'config.js'), 'utf8');
const URL_BASE = cfgSrc.match(/supabaseUrl: '(https:[^']+)'/)[1];
const ANON = cfgSrc.match(/supabaseAnonKey: '(eyJ[^']+)'/)[1];
// If the project migrated to 0004_auth.sql the RPCs only accept authenticated
// users. Set CCR_TEST_EMAIL / CCR_TEST_PASSWORD (any role works for reads) to
// sign in via GoTrue before running the parity checks.
const TEST_EMAIL = process.env.CCR_TEST_EMAIL || '';
const TEST_PASSWORD = process.env.CCR_TEST_PASSWORD || '';
let HDRS = { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' };

async function ensureToken() {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.log('note: no CCR_TEST_EMAIL/PASSWORD — calling RPCs anonymously '
      + '(fails once 0004_auth.sql is applied)');
    return;
  }
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('GoTrue login failed: '
    + (j.error_description || j.msg || j.message || ('HTTP ' + r.status)));
  HDRS.Authorization = 'Bearer ' + j.access_token;
  console.log(`signed in as ${TEST_EMAIL} (token ${j.access_token.slice(0, 18)}…)`);
}

const localVisits = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'out2508', 'visits_py.json'), 'utf8'));
const localReport = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'out2508', 'report_py.json'), 'utf8'));

let errors = 0;
function fail(m) { if (errors < 40) console.log('MISMATCH:', m); errors++; }
function numEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    const tol = Math.max(1e-9, 1e-12 * Math.max(Math.abs(a), Math.abs(b)));
    return Math.abs(a - b) <= tol;
  }
  return false;
}
function cmpVal(a, b, p) {
  if (numEq(a, b)) return;
  if (a === null || b === null || typeof a !== 'object' && typeof b !== 'object') {
    if (a !== b) fail(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    return;
  }
  fail(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

async function rpcOnce(name, params) {
  const t0 = Date.now();
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: HDRS, body: JSON.stringify(params || {})
  });
  const ms = Date.now() - t0;
  const txt = await r.text();
  if (!r.ok) throw new Error(`${name} HTTP ${r.status} (${ms}ms): ${txt.slice(0, 300)}`);
  return { data: JSON.parse(txt), ms };
}

// The local network intermittently injects a self-signed cert into the TLS
// chain (antivirus inspection), which makes undici abort the handshake.
// Retry transient transport errors a few times; keep HTTP errors fatal.
async function rpc(name, params) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await rpcOnce(name, params);
    } catch (e) {
      lastErr = e;
      const transient = /fetch failed|SELF_SIGNED|ECONNRESET|ETIMEDOUT|socket hang up/i
        .test(e.message + ' ' + (e.cause && (e.cause.code || e.cause.message) || ''));
      if (!transient || attempt === 4) throw e;
      await new Promise(res => setTimeout(res, attempt * 1500));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// A) visits RPC vs local visits — count, order, every field
// ---------------------------------------------------------------------------
function compareVisitLists(live, local, label) {
  if (!Array.isArray(live)) { fail(`${label}: not an array`); return; }
  if (live.length !== local.length) { fail(`${label}: count ${live.length} vs ${local.length}`); return; }
  const fields = Object.keys(local[0]);
  const liveFields = Object.keys(live[0] || {});
  const missing = fields.filter(f => !liveFields.includes(f));
  const extra = liveFields.filter(f => !fields.includes(f));
  if (missing.length) fail(`${label}: live missing fields ${missing}`);
  if (extra.length) fail(`${label}: live extra fields ${extra}`);
  let orderProbe = 0;
  for (let i = 0; i < local.length; i++) {
    const a = local[i], b = live[i];
    if (b === undefined) { fail(`${label}: missing row ${i}`); return; }
    if (a.date !== b.date && orderProbe++ < 3) fail(`${label}: order diverges at ${i}: ${a.date} vs ${b.date}`);
    for (const f of fields) {
      if (!(f in b)) continue;
      const x = a[f], y = b[f];
      if (numEq(x, y)) continue;
      if (x === null || y === null) {
        if (x !== y) fail(`${label} row ${i} ${f}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
        continue;
      }
      if (typeof x === 'object') {
        if (JSON.stringify(x) !== JSON.stringify(y)) fail(`${label} row ${i} ${f}: object differs`);
        continue;
      }
      fail(`${label} row ${i} ${f}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
    if (errors > 60) { fail(`${label}: too many, stopping`); return; }
  }
  console.log(`  ${label}: ${local.length} rows compared`);
}

// ---------------------------------------------------------------------------
// Emulated RPC rows from local visits (parity_hydrate §2 logic)
// ---------------------------------------------------------------------------
function emulateRpcDaily(visits) {
  const refMap = M.buildDaily(visits);
  const groups = new Map();
  for (const v of visits) {
    const key = v.dse_code + '|' + v.date;
    let g = groups.get(key);
    if (!g) { g = { rows: [] }; groups.set(key, g); }
    g.rows.push(v);
  }
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
  const rows = [];
  for (const [key, g] of groups) {
    const firstRow = g.rows[0];
    const d = refMap.get(key);
    if (!d) { fail('no reference daily for ' + key); continue; }
    let fv = null;
    for (const r of g.rows) {
      if (fv === null) { fv = r; continue; }
      const a = r.start_min === null ? Infinity : r.start_min;
      const b = fv.start_min === null ? Infinity : fv.start_min;
      if (a < b) fv = r;
    }
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
        default: row[k] = d[k];
      }
    }
    rows.push(row);
  }
  return { refMap, rows };
}

// JS hierarchyBase at no filters (Sets in encounter order; order-insensitive
// compare below because ui.js sorts before display).
function jsOptions(visits) {
  const branchLocs = new Set(), zsms = new Set(), asms = new Set(),
    asos = new Set(), channels = new Set(), dses = new Map();
  for (const r of visits) {
    branchLocs.add(r.branch_location);
    zsms.add(r.zsm);
    asms.add(r.asm);
    asos.add(r.aso);
    channels.add(r.channel);
    if (!dses.has(r.dse_code)) dses.set(r.dse_code, r.dse_name);
  }
  return {
    branchLocs: [...branchLocs], zsms: [...zsms], asms: [...asms], asos: [...asos],
    channels: [...channels].filter(c => c !== 'SPECIALITY'),
    dses: [...dses.entries()].map(([dse_code, dse_name]) => ({ dse_code, dse_name }))
  };
}
function setEq(a, b, label) {
  const sa = [...a].map(x => JSON.stringify(x)).sort();
  const sb = [...b].map(x => JSON.stringify(x)).sort();
  if (sa.length !== sb.length) { fail(`${label}: size ${sa.length} vs ${sb.length}`); return; }
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) { fail(`${label}: ${sa[i]} vs ${sb[i]}`); return; }
}

function snapshot(daily, dseList, team, discSummary, prod, discipline, er, report) {
  const DROP = new Set(['retailers', 'routes', 'storeDurations',
    'firstRowDayStart', 'firstStartMin', 'firstOnRoute', 'firstDevM']);
  const strip = d => {
    const o = {};
    for (const k of Object.keys(d)) if (!DROP.has(k)) o[k] = d[k];
    return o;
  };
  return JSON.parse(JSON.stringify({
    report,
    daily: [...daily.values()].map(strip),
    dseList, team, discSummary, productivity: prod,
    discipline: { byDse: [...discipline.byDse.entries()], byDate: [...discipline.byDate.entries()] },
    engine: {
      breakCount: (er.breaks || []).length,
      insightCount: (er.insights || []).length,
      recCount: (er.recommendations || []).length,
      breaks: (er.breaks || []).map(b => ({
        id: b.id, dse: b.dseCode || b.dse_code || b.dse || null,
        type: b.type || b.key || null, sev: b.severity || null, title: b.title || null
      }))
    }
  }));
}

function runPipeline(dailyMap, visits, report) {
  const ds = M.buildDSE(dailyMap);
  const team = M.computeBenchmarks(ds, null, dailyMap);
  M.computeRisk(ds, team);
  M.computeRanking(ds, team);
  const discipline = M.computeDisciplineFromDaily(dailyMap);
  const discSummary = M.applyDiscipline(ds, discipline);
  const prod = M.computeProductivity(null, dailyMap, Object.assign({}, M.DEFAULTS));
  const state = {
    allVisits: visits, filteredVisits: visits,
    dailyMap, dseList: ds, team, discipline,
    params: Object.assign({}, M.DEFAULTS),
    drill: { zsm: null, asm: null, aso: null },
    filters: { dateFrom: null, dateTo: null, branchLocs: [], zsms: [], asms: [], asos: [], dseCodes: [], channels: [], onRoute: 'ALL' }
  };
  const er = NS.insightEngine.run(state);
  er.recommendations = NS.recommendations.generate(state, er);
  return snapshot(dailyMap, ds, team, discSummary, prod, discipline, er, report);
}

function cmpSnap(a, b, p) {
  if (errors > 300) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { fail(`${p}: length ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) cmpSnap(a[i], b[i], `${p}[${i}]`);
    return;
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    const miss = kb.filter(k => !ka.includes(k));
    const extra = ka.filter(k => !kb.includes(k));
    if (miss.length) fail(`${p}: missing ${miss}`);
    if (extra.length) fail(`${p}: unexpected ${extra}`);
    for (const k of ka) if (kb.includes(k)) cmpSnap(a[k], b[k], `${p}.${k}`);
    return;
  }
  cmpVal(a, b, p);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('local visits:', localVisits.length);
  await ensureToken();

  const dash = await rpc('get_ccr_dashboard', {});
  console.log(`dashboard RPC: ${dash.ms}ms  daily=${dash.data.daily.length}`);

  // Visits come back in parallel date slices (a single full-range call trips
  // the API gateway's ~40s limit -> Cloudflare 520).
  const vFrom = dash.data.meta.date_min, vTo = dash.data.meta.date_max;
  const totalDays = Math.round((Date.parse(vTo) - Date.parse(vFrom)) / 86400000) + 1;
  const sliceDays = Math.max(1, Math.ceil(totalDays / 6));
  const slices = [];
  for (let d = vFrom; d <= vTo;) {
    const end = new Date(Math.min(Date.parse(d) + (sliceDays - 1) * 86400000, Date.parse(vTo)))
      .toISOString().slice(0, 10);
    slices.push([d, end]);
    d = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
  }
  const visRows = [];
  let visMs = 0;
  const tVis = Date.now();
  for (let i = 0; i < slices.length; i += 3) {
    const part = slices.slice(i, i + 3);
    const results = await Promise.all(part.map(([a, b]) =>
      rpc('get_ccr_visits', { p_date_from: a, p_date_to: b })));
    for (const r of results) { visMs += r.ms; visRows.push(...r.data); }
  }
  const vis = { data: visRows, ms: Date.now() - tVis };
  console.log(`visits RPC:    ${vis.ms}ms wall / ${visMs}ms cpu-sum  rows=${visRows.length}  slices=${slices.length}`);

  console.log('\n[1] visits RPC vs local visits');
  compareVisitLists(vis.data, localVisits, 'visits-rpc');

  const apiDump = path.join(ROOT, 'tests', 'visits_api.json');
  if (fs.existsSync(apiDump)) {
    console.log('[1b] /api/visits fallback dump vs local visits');
    compareVisitLists(JSON.parse(fs.readFileSync(apiDump, 'utf8')), localVisits, 'visits-api');
  }

  console.log('\n[2] dashboard RPC daily vs emulated rows');
  const { refMap, rows: emu } = emulateRpcDaily(localVisits);
  const live = dash.data.daily;
  if (live.length !== emu.length) fail(`daily count: live ${live.length} vs emu ${emu.length}`);
  for (let i = 0; i < Math.min(live.length, emu.length); i++) {
    const a = emu[i], b = live[i];
    if (a.dse_code !== b.dse_code || a.date !== b.date) {
      fail(`daily order at ${i}: ${a.dse_code}|${a.date} vs ${b.dse_code}|${b.date}`);
      continue;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { fail(`daily[${i}] live-only key ${k}`); continue; }
      if (!(k in b)) { fail(`daily[${i}] missing in live: ${k}`); continue; }
      cmpVal(a[k], b[k], `daily[${i}].${k}`);
    }
    if (errors > 60) { fail('daily: too many, stopping'); break; }
  }
  console.log(`  daily rows compared: ${Math.min(live.length, emu.length)}`);

  console.log('\n[3] options + meta');
  const want = jsOptions(localVisits);
  const got = dash.data.options;
  for (const k of Object.keys(want)) {
    if (!got[k]) { fail(`options.${k} missing`); continue; }
    if (k === 'dses') setEq(want[k], got[k], 'options.dses');
    else setEq(want[k], got[k], `options.${k}`);
  }
  const meta = dash.data.meta;
  const dates = localVisits.map(v => v.date);
  const dmin = dates.reduce((x, y) => (x < y ? x : y));
  const dmax = dates.reduce((x, y) => (x > y ? x : y));
  cmpVal(meta.date_min, dmin, 'meta.date_min');
  cmpVal(meta.date_max, dmax, 'meta.date_max');
  cmpVal(meta.total_visits, localVisits.length, 'meta.total_visits');
  cmpVal(meta.has_data, true, 'meta.has_data');
  cmpSnap(meta.report, localReport, 'meta.report');

  console.log('\n[4] hydrate(live daily) pipeline vs reference pipeline');
  const hydrated = M.hydrateDailyRows(live);
  const refKeys = [...refMap.keys()], hydKeys = [...hydrated.keys()];
  if (refKeys.length !== hydKeys.length) fail(`dailyMap size: ${refKeys.length} vs ${hydKeys.length}`);
  for (let i = 0; i < Math.min(refKeys.length, hydKeys.length); i++) {
    if (refKeys[i] !== hydKeys[i]) fail(`dailyMap order at ${i}: ${refKeys[i]} vs ${hydKeys[i]}`);
  }
  const snapRef = runPipeline(refMap, localVisits, localReport);
  const snapLive = runPipeline(hydrated, vis.data, meta.report || localReport);
  cmpSnap(snapLive, snapRef, 'snapshot');

  if (errors === 0) {
    console.log('\nLIVE PARITY OK — get_ccr_dashboard + get_ccr_visits match the proven local pipeline');
    console.log(`timings: dashboard ${dash.ms}ms, visits ${vis.ms}ms (local xlsx baseline: parse ~36s + engine ~2s)`);
    process.exit(0);
  }
  console.log(`\nFAILED with ${errors} mismatches`);
  process.exit(1);
}

main().catch(e => {
  console.error('ERROR:', e.message);
  if (e.cause) console.error('cause:', e.cause.code || e.cause.message || String(e.cause));
  process.exit(2);
});


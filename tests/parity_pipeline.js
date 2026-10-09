// End-to-end pipeline parity: metrics + discipline + productivity + engine run
// on the PYTHON-produced visits must exactly match the JS golden snapshot.
// Run: node parity_pipeline.js
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

const DIR = __dirname;
const visits = JSON.parse(fs.readFileSync(path.join(DIR, 'visits_py.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(DIR, 'report_py.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'golden_ref.json'), 'utf8'));
const ref = golden.snapshot;

const built = NS.metrics.buildAll(visits);
const state = {
  allVisits: visits, filteredVisits: visits,
  dailyMap: built.dailyMap, dseList: built.dseList, team: built.team,
  discipline: built.discipline, params: Object.assign({}, NS.metrics.DEFAULTS),
  drill: { zsm: null, asm: null, aso: null },
  filters: { dateFrom: null, dateTo: null, branchLocs: [], zsms: [], asms: [], asos: [], dseCodes: [], channels: [], onRoute: 'ALL' }
};
const discSummary = NS.metrics.applyDiscipline(built.dseList, built.discipline);
const prod = NS.metrics.computeProductivity(visits, built.dailyMap, state.params);
const er = NS.insightEngine.run(state);
er.recommendations = NS.recommendations.generate(state, er);

const snap = {
  report,
  daily: [...built.dailyMap.values()].map(d => ({
    ...d,
    retailers: d.retailers instanceof Set ? [...d.retailers].sort() : d.retailers,
    routes: d.routes instanceof Set ? [...d.routes].sort() : d.routes,
    storeDurations: d.storeDurations ? d.storeDurations.length : null
  })),
  dseList: built.dseList,
  team: built.team,
  discSummary,
  productivity: prod,
  discipline: { byDse: [...built.discipline.byDse.entries()], byDate: [...built.discipline.byDate.entries()] },
  engine: { breakCount: (er.breaks || []).length, insightCount: (er.insights || []).length, recCount: (er.recommendations || []).length, breaks: (er.breaks || []).map(b => ({ id: b.id, dse: b.dseCode || b.dse_code || b.dse || null, type: b.type || b.key || null, sev: b.severity || null, title: b.title || null })) }
};

let errors = 0;
// Normalize through JSON like golden.js does (drops keys with undefined values,
// e.g. recCount when recommendations.generate returns a non-array).
const snapN = JSON.parse(JSON.stringify(snap));
const ALLOWED_NEW = new Set(['offRouteProdYes']); // additive metrics field (golden2)
function fail(m) { if (errors < 40) console.log('MISMATCH:', m); errors++; }

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

cmp(snapN, ref, 'snapshot');

if (errors === 0) {
  console.log('PIPELINE PARITY OK — report, daily, dseList, team, discipline,',
    'productivity, engine all match golden on Python visits');
  process.exit(0);
} else {
  console.log('FAILED with', errors, 'mismatches');
  process.exit(1);
}

// Compare JS vs Python pipeline outputs (visits + report).
// Run: node compare_visits.js [indir]
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || __dirname;
const visitsJs = JSON.parse(fs.readFileSync(path.join(DIR, 'visits_js.json'), 'utf8'));
const visitsPy = JSON.parse(fs.readFileSync(path.join(DIR, 'visits_py.json'), 'utf8'));
const reportJs = JSON.parse(fs.readFileSync(path.join(DIR, 'report_js.json'), 'utf8'));
const reportPy = JSON.parse(fs.readFileSync(path.join(DIR, 'report_py.json'), 'utf8'));

let errors = 0;
function fail(msg) {
  if (errors < 30) console.log('MISMATCH:', msg);
  errors++;
}

// ---- report: exact structural equality -------------------------------------
function deepEq(a, b, p) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { fail(`${p}: length ${a.length} vs ${b.length}`); return; }
    for (let i = 0; i < a.length; i++) deepEq(a[i], b[i], `${p}[${i}]`);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(',') !== kb.join(',')) { fail(`${p}: keys [${ka}] vs [${kb}]`); return; }
    for (const k of ka) deepEq(a[k], b[k], `${p}.${k}`);
    return;
  }
  if (a !== b) fail(`${p}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}
console.log('report:');
deepEq(reportJs, reportPy, 'report');

// ---- visits: row-by-row, field-by-field ------------------------------------
console.log('visits:');
if (visitsJs.length !== visitsPy.length) {
  fail(`count ${visitsJs.length} vs ${visitsPy.length}`);
} else {
  const skip = new Set(['dateObj']); // JS stores local-midnight ms, Python UTC (unused field)
  const fields = Object.keys(visitsJs[0]);
  const pyFields = Object.keys(visitsPy[0]);
  const missing = fields.filter(f => !pyFields.includes(f) && !f.startsWith('_'));
  if (missing.length) fail(`python missing fields: ${missing}`);
  const extra = pyFields.filter(f => !fields.includes(f));
  if (extra.length) fail(`python extra fields: ${extra}`);
  const numDiff = (a, b) => {
    if (a === b) return false;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Number.isNaN(a) && Number.isNaN(b)) return false;
      const tol = Math.max(1e-9, 1e-12 * Math.max(Math.abs(a), Math.abs(b)));
      return !(Math.abs(a - b) <= tol);
    }
    return true;
  };
  for (let i = 0; i < visitsJs.length; i++) {
    const a = visitsJs[i], b = visitsPy[i];
    for (const f of fields) {
      if (skip.has(f)) continue;
      if (numDiff(a[f], b[f])) fail(`row ${i} field ${f}: ${JSON.stringify(a[f])} vs ${JSON.stringify(b[f])}`);
    }
    if (errors > 200) { fail('...too many, stopping'); break; }
  }
}

if (errors === 0) {
  console.log('PARITY OK — report and', visitsJs.length, 'visits identical (dateObj excluded: TZ-dependent, unused)');
  process.exit(0);
} else {
  console.log('FAILED with', errors, 'mismatches');
  process.exit(1);
}

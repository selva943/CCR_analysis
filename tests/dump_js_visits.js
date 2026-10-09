// Dump the JS pipeline's visits + report for parity comparison with the Python port.
// Run: node dump_js_visits.js [outdir] [xlsx]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = 'G:\\Selva\\CCR_analysis';
const OUT = process.argv[2] || __dirname;
const XLSX_FILE = process.argv[3] || path.join(ROOT, 'Input', 'MTD_CCR.xlsx');
global.window = global;
const XLSX = require(path.join(ROOT, 'dashboard', 'vendor', 'xlsx.full.min.js'));
require(path.join(ROOT, 'dashboard', 'js', 'data.js'));

const buf = fs.readFileSync(XLSX_FILE);
const wb = XLSX.read(buf, { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
const res = global.DSE.processSheet(rows);

fs.writeFileSync(path.join(OUT, 'visits_js.json'), JSON.stringify(res.visits));
fs.writeFileSync(path.join(OUT, 'report_js.json'), JSON.stringify(res.report, null, 1));
console.log('visits:', res.visits.length, 'report totalRows:', res.report.totalRows);

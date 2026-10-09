const fs = require('fs');
const path = require('path');

const ROOT = 'G:/Selva/CCR_analysis/dashboard';
const XLSX_SRC = 'G:/Selva/CCR_analysis/Input/MTD_CCR.xlsx';
const OUT = 'G:/Selva/CCR_analysis/output/MTD_CCR_Dashboard.html';

// Browser API polyfills so we can reuse the dashboard's compact encoder.
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
global.atob = s => Buffer.from(s, 'base64').toString('binary');
global.window = { DSE: {} };
require(path.join(ROOT, 'js', 'data.js'));
const NS = global.window.DSE;

function inlineCss(file) {
  return '<style>\n' + fs.readFileSync(path.join(ROOT, file), 'utf8') + '\n</style>';
}

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 1. Inline stylesheets (leaflet.css, css/app.css) in place.
html = html.replace(
  /<link rel="stylesheet" href="([^"]+)">/g,
  (m, f) => inlineCss(f)
);

// 2. Inline every vendor + app script in place (order preserved).
// Escape only the dangerous `</script` (case-insensitive) as `<\` + `/script`
// (backslash between the brackets) so the HTML tokenizer never closes the
// block early. JS semantics are identical (`\/` is just `/`).
const readScript = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<\/script/gi, '<\\/script');
html = html.replace(
  /<script src="([^"]+)"><\/script>\s*/g,
  (m, f) => '<script>\n' + readScript(f) + '\n</script>'
);

// 3. Parse the workbook and embed a compact (columnar, gzipped) representation of
//    the visits instead of the raw XLSX. This is ~6x smaller and lets the file
//    load without re-parsing the workbook.
console.log('Reading ' + XLSX_SRC + ' ...');
const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
const wbBytes = fs.readFileSync(XLSX_SRC);
const wb = XLSX.read(wbBytes, { type: 'buffer' });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
const res = NS.processSheet(rows);
console.log('Visits:', res.visits.length, 'of', rows.length, 'rows');

(async () => {
  const enc = await NS.encodeVisitsCompact(res.visits);
  console.log('Embedded compact b64 MB:', (enc.b64.length / 1048576).toFixed(2));

  const appScript = '<script>\n' + readScript('js/app.js') + '\n</script>';
  const dataScript = '<script>window.__EMBEDDED_XLSX_B64__ = "' + enc.b64 + '"; window.__EMBEDDED_META__ = ' + JSON.stringify({ kind: 'compact', enc: enc.meta.enc, N: enc.N }) + ';</script>';
  html = html.replace(appScript, dataScript + '\n' + appScript);

  // 4. Verify nothing was left external. Strip <script> blocks first so string
  //    literals inside inlined JS don't cause false positives, then match full
  //    external tags (with quote + closing >) in the remaining markup.
  const markup = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  const leftover = markup.match(/<script src="[^"]*"><\/script>|<link rel="stylesheet" href="[^"]*">/g);
  if (leftover) {
    console.error('Leftover external refs:', leftover);
    process.exit(1);
  }
  if (!html.includes('window.__EMBEDDED_XLSX_B64__')) {
    console.error('Embed injection missing');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  console.log('Wrote', OUT);
  console.log('Output size (MB):', (Buffer.byteLength(html) / 1048576).toFixed(1));
})().catch(e => { console.error('Build failed:', e && e.stack || e); process.exit(1); });
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DASH = path.join(ROOT, 'dashboard');
const XLSX = path.join(ROOT, 'Input', 'MTD_CCR.xlsx');
const DIST = path.join(ROOT, 'dist');
const EMBED_DATA = process.env.EMBED_DATA === '1';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'USER_GUIDE.md' || e.name === 'build_single.cjs') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function mb(file) {
  return (fs.statSync(file).size / 1048576).toFixed(1);
}

if (EMBED_DATA && !fs.existsSync(XLSX)) {
  console.error('Missing ' + XLSX + ' (EMBED_DATA=1 requested)');
  process.exit(1);
}

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

copyDir(DASH, path.join(DIST, 'dashboard'));

if (EMBED_DATA) {
  fs.mkdirSync(path.join(DIST, 'Input'), { recursive: true });
  fs.copyFileSync(XLSX, path.join(DIST, 'Input', 'MTD_CCR.xlsx'));
}

fs.writeFileSync(path.join(DIST, '_redirects'), '/  /dashboard/  301\n');
// No content hashing in filenames, so app assets must revalidate quickly —
// only vendor bundles (rarely change) get long immutable caching.
let headerLines = [
  '/vendor/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '/js/*',
  '  Cache-Control: public, max-age=300, must-revalidate',
  '/css/*',
  '  Cache-Control: public, max-age=300, must-revalidate',
  '/config.js',
  '  Cache-Control: public, max-age=60, must-revalidate'
];
if (EMBED_DATA) {
  headerLines = headerLines.concat(['/Input/*', '  Cache-Control: public, max-age=3600']);
}
fs.writeFileSync(path.join(DIST, '_headers'), headerLines.join('\n') + '\n');

let total = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
}
walk(DIST);

console.log('dist/ built for Netlify');
console.log('  dashboard/ assets  : ' + mb(path.join(DIST, 'dashboard', 'vendor', 'plotly.min.js')) + ' MB (plotly)');
if (EMBED_DATA) console.log('  Input/MTD_CCR.xlsx  : ' + mb(path.join(DIST, 'Input', 'MTD_CCR.xlsx')) + ' MB (data, embedded)');
else console.log('  Input/MTD_CCR.xlsx  : (not embedded — deploy-1 is a one-time static app; load data daily in the browser)');
console.log('  dist total          : ' + (total / 1048576).toFixed(1) + ' MB');
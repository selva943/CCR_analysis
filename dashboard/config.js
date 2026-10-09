// Supabase + backend configuration for the CCR dashboard fast path.
//
// Leave supabaseUrl/supabaseAnonKey empty to keep the app fully local (xlsx
// only). When filled in, the dashboard loads its summary from Postgres via
// the get_ccr_dashboard RPC and fetches row-level visits from apiBase.
//
// You can also override at runtime BEFORE this file loads:
//   <script>window.__CCR_CONFIG__ = { supabaseUrl: '…', supabaseAnonKey: '…', apiBase: '…' }</script>
window.__CCR_CONFIG__ = Object.assign({
  supabaseUrl: 'https://hhtakkehaewqvpvpmhrj.supabase.co', // no trailing slash
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhodGFra2VoYWV3cXZwdnBtaHJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1MTYzNjEsImV4cCI6MjEwNzA5MjM2MX0.EODc3pxHO8SDxVJ2Sxsmh8W8nECocFA_eReSw1OvaOU', // publishable/anon key — safe to expose in the browser
  apiBase: 'http://localhost:8000', // FastAPI backend origin (row-level visits + upload)
  importToken: ''    // optional CCR_IMPORT_TOKEN, only if the backend requires it
}, window.__CCR_CONFIG__ || {});

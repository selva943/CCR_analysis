// Supabase + backend configuration for the CCR dashboard fast path.
//
// Leave supabaseUrl/supabaseAnonKey empty to keep the app fully local (xlsx
// only). When filled in, the dashboard loads its summary from Postgres via
// the get_ccr_dashboard RPC and fetches row-level visits from apiBase.
//
// You can also override at runtime BEFORE this file loads:
//   <script>window.__CCR_CONFIG__ = { supabaseUrl: '…', supabaseAnonKey: '…', apiBase: '…' }</script>
window.__CCR_CONFIG__ = Object.assign({
  supabaseUrl: 'https://cfulxkhzcfyhvyvuzloy.supabase.co', // no trailing slash
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmdWx4a2h6Y2Z5aHZ5dnV6bG95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5ODk5MDksImV4cCI6MjEwODU2NTkwOX0.jTk93sMg6JX3FTy-t0dVjmehUF046eJoI9GZalxjZMw', // publishable/anon key — safe to expose in the browser
  apiBase: 'https://ccr-analysis.onrender.com', // deployed FastAPI backend (imports + row-level visits)
  importToken: 'a7XdWG5KHFTgmEO-3P3E-hJyFva7JNOE' // must match CCR_IMPORT_TOKEN on the backend
}, window.__CCR_CONFIG__ || {});

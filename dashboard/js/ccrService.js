// CCR dashboard data service — Supabase RPCs (summary + row-level visits) with
// a FastAPI backend fallback (/api/visits, upload, health).
//
// Fast path: get_ccr_dashboard returns per-DSE-day accumulators (~9k rows) that
// metrics.js hydrateDailyRows() turns into the same dailyMap the xlsx pipeline
// builds, so all downstream modules stay unchanged. Row-level visits come from
// the get_ccr_visits RPC for the modules that need them (Spend / Geo / Risk /
// DSE profiles).
(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});

  const DASH_TTL = 10 * 60 * 1000;
  const VISIT_TTL = 5 * 60 * 1000;
  const DASH_CACHE_MAX = 10;
  const VISIT_CACHE_MAX = 2; // rows are huge; keep only current + previous

  const dashCache = new Map(); // filterKey -> { t, data }
  const dashPending = new Map(); // filterKey -> Promise
  const visCache = new Map(); // filterKey -> { t, data }
  const visPending = new Map(); // filterKey -> Promise

  function cfg() { return window.__CCR_CONFIG__ || {}; }
  function supabaseUrl() { return String(cfg().supabaseUrl || '').trim().replace(/\/+$/, ''); }
  function anonKey() { return String(cfg().supabaseAnonKey || '').trim(); }
  function apiBase() { return String(cfg().apiBase || '').trim().replace(/\/+$/, ''); }

  function isConfigured() { return !!(supabaseUrl() && anonKey()); }
  function apiConfigured() { return !!apiBase(); }

  // With the local employee login there is no Supabase JWT, so 401 responses
  // are ordinary permission failures — only a real session expiry should drop
  // the user back to the login screen.
  function hasAuthToken() {
    return !!(NS.auth && NS.auth.accessToken && NS.auth.accessToken());
  }
  function onUnauthorized() {
    if (hasAuthToken() && NS.auth && NS.auth.onUnauthorized) NS.auth.onUnauthorized();
  }

  function filterKey(f) {
    const A = a => (a && a.length ? [...a].sort().join('|') : '');
    return [
      f.dateFrom || '', f.dateTo || '',
      A(f.branchLocs), A(f.zsms), A(f.asms), A(f.asos), A(f.dseCodes), A(f.channels),
      f.onRoute || 'ALL'
    ].join('~');
  }

  // Only non-empty filters are sent; the RPC treats absent/empty as no filter.
  function rpcParams(f) {
    const p = {};
    if (f.dateFrom) p.p_date_from = f.dateFrom;
    if (f.dateTo) p.p_date_to = f.dateTo;
    if (f.branchLocs && f.branchLocs.length) p.p_branch_locs = f.branchLocs;
    if (f.zsms && f.zsms.length) p.p_zsms = f.zsms;
    if (f.asms && f.asms.length) p.p_asms = f.asms;
    if (f.asos && f.asos.length) p.p_asos = f.asos;
    if (f.dseCodes && f.dseCodes.length) p.p_dse_codes = f.dseCodes;
    if (f.channels && f.channels.length) p.p_channels = f.channels;
    p.p_on_route = f.onRoute || 'ALL';
    return p;
  }

  function cacheGet(map, key, ttl, max) {
    const c = map.get(key);
    if (!c) return null;
    if (Date.now() - c.t > ttl) { map.delete(key); return null; }
    map.delete(key); map.set(key, c); // refresh LRU position
    void max;
    return c.data;
  }

  function cachePut(map, key, data, max) {
    map.set(key, { t: Date.now(), data });
    while (map.size > max) map.delete(map.keys().next().value);
  }

  async function rpc(name, params) {
    const headers = { 'apikey': anonKey(), 'Content-Type': 'application/json' };
    const tok = NS.auth && NS.auth.accessToken && NS.auth.accessToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    const r = await fetch(supabaseUrl() + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers,
      body: JSON.stringify(params || {})
    });
    if (!r.ok) {
      if (r.status === 401) onUnauthorized();
      const t = await r.text().catch(() => '');
      throw new Error('Supabase RPC ' + name + ' failed (HTTP ' + r.status + '): ' + t.slice(0, 300));
    }
    return r.json();
  }

  // Returns { daily[], options{}, meta{} } for the given filters.
  async function getDashboard(f) {
    const key = filterKey(f);
    const hit = cacheGet(dashCache, key, DASH_TTL, DASH_CACHE_MAX);
    if (hit) return hit;
    if (dashPending.has(key)) return dashPending.get(key);
    const p = rpc('get_ccr_dashboard', rpcParams(f)).then(data => {
      cachePut(dashCache, key, data, DASH_CACHE_MAX);
      return data;
    }).finally(() => dashPending.delete(key));
    dashPending.set(key, p);
    return p;
  }

  function visitsQuery(f) {
    const q = new URLSearchParams();
    if (f.dateFrom) q.set('dateFrom', f.dateFrom);
    if (f.dateTo) q.set('dateTo', f.dateTo);
    const add = (k, arr) => { if (arr && arr.length) arr.forEach(v => q.append(k, v)); };
    add('branch_loc', f.branchLocs);
    add('zsms', f.zsms);
    add('asms', f.asms);
    add('asos', f.asos);
    add('dse_code', f.dseCodes);
    add('channels', f.channels);
    if (f.onRoute && f.onRoute !== 'ALL') q.set('onRoute', f.onRoute);
    return q;
  }

  async function fetchVisitRows(url) {
    const headers = { 'Accept': 'application/json' };
    const tok = NS.auth && NS.auth.accessToken && NS.auth.accessToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      if (r.status === 401) onUnauthorized();
      const t = await r.text().catch(() => '');
      throw new Error('Visit rows failed (HTTP ' + r.status + '): ' + t.slice(0, 300));
    }
    // Server responds with Content-Encoding: gzip — the browser inflates it
    // transparently, so r.json() sees plain JSON.
    return r.json();
  }

  function addDays(ymd, n) {
    const ms = Date.parse(ymd + 'T00:00:00Z') + n * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
  }

  // get_ccr_visits over the whole import in one shot would build a ~170MB
  // jsonb payload and hits the API gateway's ~40s limit (Cloudflare 520).
  // Slice by date range instead: each slice is a small RPC, slices run in
  // parallel batches, and concatenation preserves (business_date, id) order.
  const VISIT_SLICES = 10;      // target at most this many slices (fallback path)
  const VISIT_PARALLEL = 4;     // concurrent slice requests (more starves the shared instance CPU)

  async function fetchVisitSlices(f) {
    // meta.date_min/max are import-wide (filters don't move them), so any
    // cached/first dashboard call gives the full window.
    const dash = await getDashboard(f);
    const from = f.dateFrom || (dash.meta && dash.meta.date_min);
    const to = f.dateTo || (dash.meta && dash.meta.date_max);
    if (!from || !to || daysBetween(from, to) <= 1) {
      return rpc('get_ccr_visits', rpcParams(f));
    }
    const sliceDays = Math.max(1, Math.ceil(daysBetween(from, to) / VISIT_SLICES));
    const slices = [];
    for (let d = from; d <= to; d = addDays(d, sliceDays)) {
      slices.push([d, addDays(d, sliceDays - 1) <= to ? addDays(d, sliceDays - 1) : to]);
    }
    const out = [];
    for (let i = 0; i < slices.length; i += VISIT_PARALLEL) {
      const part = slices.slice(i, i + VISIT_PARALLEL);
      const results = await Promise.all(part.map(([a, b]) =>
        rpc('get_ccr_visits', Object.assign(rpcParams(f), { p_date_from: a, p_date_to: b }))));
      for (const rows of results) {
        if (!Array.isArray(rows)) throw new Error('Visits RPC returned non-array payload');
        for (const row of rows) out.push(row);
      }
    }
    return out;
  }

  // Row-level visits for the current filters. Primary path: get_ccr_visits
  // RPCs sliced by date, in parallel — this works anonymously against the
  // public anon key. The FastAPI /api/visits endpoint is used only when
  // Supabase is NOT configured (local-only setup): on free hosting tiers the
  // full-range response is too large for the edge proxy, so it is unreliable.
  async function getVisits(f) {
    const key = filterKey(f);
    const hit = cacheGet(visCache, key, VISIT_TTL, VISIT_CACHE_MAX);
    if (hit) return hit;
    if (visPending.has(key)) return visPending.get(key);
    const viaBackend = () =>
      fetchVisitRows(apiBase() + '/api/visits?' + visitsQuery(f).toString());
    const primary = isConfigured()
      ? fetchVisitSlices(f)
      : apiConfigured()
          ? viaBackend()
          : Promise.reject(new Error('No data source configured'));
    const p = primary
      .then(rows => {
        if (!Array.isArray(rows)) throw new Error('Visits payload is not an array');
        cachePut(visCache, key, rows, VISIT_CACHE_MAX);
        return rows;
      }).finally(() => visPending.delete(key));
    visPending.set(key, p);
    return p;
  }

  // Every visit of the active import (for standalone-HTML export).
  function getAllVisits() {
    return getVisits({ onRoute: 'ALL' });
  }

  // Uploads an xlsx to the backend; resolves to the finished import job record.
  // POST /api/import only spools the file and starts a background worker
  // (Render kills requests that run for minutes), so the response job is
  // PROCESSING and we poll /api/jobs/{id} until it COMPLETES or FAILS.
  const JOB_POLL_MS = 3000;
  const JOB_TIMEOUT_MS = 30 * 60 * 1000;

  async function importXlsx(file) {
    if (!apiConfigured()) throw new Error('Backend not configured (apiBase in config.js)');
    const fd = new FormData();
    fd.append('file', file);
    const headers = authHeaders();
    const r = await fetch(apiBase() + '/api/import', { method: 'POST', body: fd, headers });
    let body = null;
    try { body = await r.json(); } catch (_) { /* non-JSON error body */ }
    if (!r.ok) {
      if (r.status === 401) onUnauthorized();
      const detail = body && body.detail ? JSON.stringify(body.detail) : '';
      throw new Error('Import failed (HTTP ' + r.status + ') ' + detail + (r.status === 403 ? ' — admin role required to process data' : ''));
    }
    if (!body || !body.job) throw new Error('Import failed — no job returned');
    if (body.idempotent || body.job.status === 'COMPLETED' || body.job.status === 'FAILED') {
      return body.job;
    }
    return waitForJob(body.job.id);
  }

  async function waitForJob(jobId) {
    const url = apiBase() + '/api/jobs/' + encodeURIComponent(jobId);
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      try {
        const r = await fetch(url, { headers: authHeaders() });
        const body = await r.json();
        const job = body && body.job;
        if (r.ok && job) {
          if (job.status === 'COMPLETED') return job;
          if (job.status === 'FAILED') return job;
        }
      } catch (_) { /* transient poll error — keep trying */ }
      if (Date.now() > deadline) {
        throw new Error('Import timed out after 30 minutes — check the server logs');
      }
      await new Promise(res => setTimeout(res, JOB_POLL_MS));
    }
  }

  function authHeaders() {
    const headers = {};
    const tok = NS.auth && NS.auth.accessToken && NS.auth.accessToken();
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    if (cfg().importToken) headers['X-Import-Token'] = cfg().importToken;
    return headers;
  }

  async function backendHealth() {
    if (!apiConfigured()) return null;
    try {
      const r = await fetch(apiBase() + '/api/health');
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  // Records an app-open for the signed-in user (admin usage report). With the
  // local employee login there is no Supabase JWT, so the employee code/name
  // from the session is passed to the log_access RPC instead.
  function logAccess() {
    if (!isConfigured()) return Promise.resolve(null);
    const s = NS.auth && NS.auth.load ? NS.auth.load() : null;
    const u = s && s.user;
    if (!u || !u.code) return Promise.resolve(null);
    return rpc('log_access', { p_emp_code: u.code, p_emp_name: u.name, p_role: u.role })
      .catch(() => null);
  }

  // Admin-only daily per-user activity report. The signed-in admin's employee
  // code is passed so the RPC can gate access without a Supabase session.
  function getAccessReport(from, to) {
    const p = {};
    if (from) p.p_date_from = from;
    if (to) p.p_date_to = to;
    const s = NS.auth && NS.auth.load ? NS.auth.load() : null;
    if (s && s.user && s.user.code) p.p_admin_code = s.user.code;
    return rpc('get_access_report', p);
  }

  function clearCaches() {
    dashCache.clear(); dashPending.clear();
    visCache.clear(); visPending.clear();
  }

  NS.ccr = {
    isConfigured, apiConfigured, supabaseUrl, apiBase,
    filterKey, getDashboard, getVisits, getAllVisits,
    importXlsx, backendHealth, logAccess, getAccessReport, clearCaches
  };
})();

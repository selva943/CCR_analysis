// CCR dashboard auth — Supabase GoTrue (email/password) + role session.
//
// Drop-in, no external library: talks to {supabaseUrl}/auth/v1/* directly and
// keeps the session (access + refresh token, user, role, expiry) in
// localStorage under 'ccr.auth'. The dashboard app only fetches data from
// Supabase after a session is present; the data RPCs/APIs are locked down on
// the server side (RLS + admin JWT on the backend).
//
// Roles: 'admin' can process (import) the data; 'viewer' can only view. The
// role is read from the get_my_role() RPC after sign-in and cached in the
// session so the UI can gate the import controls.
(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});

  const KEY = 'ccr.auth';
  const EXPIRY_MARGIN = 60; // refresh 60s before the token actually expires

  function cfg() { return window.__CCR_CONFIG__ || {}; }
  function base() { return String(cfg().supabaseUrl || '').trim().replace(/\/+$/, ''); }
  function anon() { return String(cfg().supabaseAnonKey || '').trim(); }

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function store(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function clear() { try { localStorage.removeItem(KEY); } catch (_) {} }

  async function goTrue(path, body, token) {
    const headers = { apikey: anon(), 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base() + '/auth/v1/' + path, {
      method: 'POST', headers, body: JSON.stringify(body || {})
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {}
    if (!r.ok) {
      const msg = (j && (j.error_description || j.msg || j.message || j.error))
        || ('Log-in failed (HTTP ' + r.status + ')');
      throw new Error(String(msg));
    }
    return j;
  }

  function toSession(json) {
    const u = json.user || {};
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token || '',
      expires_at: json.expires_at || (nowSec() + (json.expires_in || 3600)),
      user: {
        id: u.id || '',
        email: u.email || '',
        role: (u.app_metadata && u.app_metadata.ccr_role) || ''
      }
    };
  }

  function accessToken() {
    const s = load();
    return (s && s.access_token) || null;
  }

  // Returns the cached session, refreshing the access token first if needed.
  async function ensureSession() {
    const s = load();
    if (!s || !s.access_token) return null;
    if (s.expires_at && s.expires_at > nowSec() + EXPIRY_MARGIN) return s;
    if (!s.refresh_token) { clear(); return null; }
    try {
      const json = await goTrue('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
      const next = toSession(json);
      if (!s.user.role && next.user.role) s.user.role = next.user.role;
      next.user = next.user.id ? next.user : s.user;
      Object.assign(next, { user: Object.assign({}, s.user, next.user) });
      store(next);
      return next;
    } catch (_) {
      clear();
      return null;
    }
  }

  async function myRole(token) {
    const r = await fetch(base() + '/rest/v1/rpc/get_my_role', {
      method: 'POST',
      headers: {
        apikey: anon(),
        Authorization: 'Bearer ' + (token || ''),
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (!r.ok) throw new Error('Role lookup failed (HTTP ' + r.status + ')');
    return r.json();
  }

  async function signIn(email, password) {
    const json = await goTrue('token?grant_type=password', { email, password });
    const s = toSession(json);
    try {
      const role = await myRole(s.access_token);
      if (role) s.user.role = role;
    } catch (_) { /* role unknown yet — server still enforces */
    }
    store(s);
    return s;
  }

  async function signOut() {
    const s = load();
    clear();
    if (s && s.access_token) {
      try { await goTrue('logout', {}, s.access_token); } catch (_) {}
    }
  }

  function isAdmin(s) {
    const u = (s || load() || {}).user;
    if (!u) return false;
    return u.role === 'admin'
      || !!(u.app_metadata && u.app_metadata.ccr_role === 'admin');
  }

  // Called by ccrService when a data call gets a 401: the token is stale or
  // revoked, so drop the session and force the login screen.
  function onUnauthorized() {
    clear();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ccr-auth-required'));
    }
  }

  NS.auth = {
    signIn, signOut, ensureSession, accessToken, myRole,
    isAdmin, onUnauthorized, store, load, clear
  };
})();
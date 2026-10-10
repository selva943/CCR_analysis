// CCR dashboard auth — local employee login (Emp Code + shared password).
//
// The GoTrue (email/password) login is replaced by a whitelist of employees.
// Anyone whose Emp Code is in USER_LIST signs in with the single shared
// password. The session is kept in localStorage under 'ccr.auth'; there is no
// Supabase access token anymore — the dashboard reads Supabase with the public
// anon key (migration 0006_anon_read.sql grants anon SELECT on the data).
//
// Roles: 'admin' can process (import) the data; 'viewer' can only view. The
// role is resolved from the whitelist.
(function () {
  'use strict';

  const NS = (window.DSE = window.DSE || {});

  const KEY = 'ccr.auth';
  const PASSWORD = 'smsalesreports@321';

  const USER_LIST = [
    { code: 'SMT5874',  name: 'PAUL PRATHAP BISSON',  role: 'viewer' },
    { code: 'SM00118',  name: 'KALIAPPAN M',          role: 'viewer' },
    { code: 'SM04258',  name: 'SENTHILKUMAR S B',     role: 'viewer' },
    { code: 'SM00823',  name: 'SENTHILKUMAR',         role: 'viewer' },
    { code: 'SM10787',  name: 'MOHAMED JARIZES',      role: 'viewer' },
    { code: 'SM11740',  name: 'ARAVINTH PRABHU. L',   role: 'viewer' },
    { code: 'SM00977',  name: 'PATACHAMUTHU R',       role: 'viewer' },
    { code: 'SMM8224',  name: 'SUDHARSAN G',          role: 'viewer' },
    { code: 'SM00009',  name: 'Cluster 1',            role: 'viewer' },
    { code: 'SM00062',  name: 'Cluster 2',            role: 'viewer' },
    { code: 'Adminmis01', name: 'Admin',              role: 'admin' }
  ];

  function store(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  function clear() { try { localStorage.removeItem(KEY); } catch (_) {} }

  // No Supabase JWT is carried anymore — reads go out with the public anon key.
  function accessToken() { return null; }

  function ensureSession() { return Promise.resolve(load()); }

  function myRole() {
    const s = load();
    return (s && s.user && s.user.role) || null;
  }

  async function signIn(empCode, password) {
    const code = String(empCode || '').trim();
    const pass = String(password || '');
    const user = USER_LIST.find(u => u.code.toLowerCase() === code.toLowerCase());
    if (!user) throw new Error('Unknown employee code — contact the admin.');
    if (pass !== PASSWORD) throw new Error('Incorrect password.');
    const s = { user: { id: user.code, code: user.code, name: user.name, role: user.role } };
    store(s);
    return s;
  }

  async function signOut() { clear(); }

  function isAdmin(s) {
    const u = (s || load() || {}).user;
    return !!(u && u.role === 'admin');
  }

  // Kept for compatibility — data calls now use the anon key, so there is no
  // per-user Supabase session to drop. Only clears our local session.
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
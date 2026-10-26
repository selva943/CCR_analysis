# MTD CCR Dashboard — Live Database Setup Guide

This document explains how to run the MTD CCR DSE analytics dashboard as a
**live database–connected project** instead of the default "load an .xlsx in the
browser" mode.

The live stack is **already scaffolded** in this repository (Supabase schema,
RPC functions, a FastAPI backend and a browser data service). The current
dashboard uses a local employee-code login UI; Supabase reads use the public
anon key, so that UI is not database-level access control. This guide covers
the architecture, setup steps, data flow, endpoints and common issues.

For a fresh, empty replacement Supabase project, follow
[NEW_SUPABASE_PROJECT.md](./NEW_SUPABASE_PROJECT.md).

---

## 1. Architecture at a glance

```
┌─────────────────────────────┐
│  Browser (dashboard/)       │
│  index.html + js/*          │
│   • config.js  ─── URLs/keys│
│   • ccrService.js ─ data svc│
│   • metrics.js / ui.js      │
│     (all analytics)         │
└───────────┬─────────────────┘
            │
   ┌────────┴─────────────┐
   │                      │
   ▼                      ▼
┌──────────────────┐  ┌──────────────────────────┐
│ Supabase         │  │ FastAPI backend          │
│ PostgREST + RPC  │  │ backend/app/main.py      │
│  • get_ccr_      │  │  • POST /api/import      │
│    dashboard     │  │  • GET  /api/visits      │
│  • get_ccr_visits│  │  • GET  /api/jobs        │
│  (reads)         │  │  • GET  /api/health      │
└────────┬─────────┘  └────────────┬─────────────┘
         │                         │
         ▼                         ▼
      ┌───────────────────────────────────┐
      │  Supabase Postgres                │
      │   public.ccr_import_jobs (jobs)   │
      │   public.ccr_raw (normalized rows)│
      └───────────────────────────────────┘
```

**Design principle:** parsing and the "source of truth" live in the browser's
`dashboard/js/data.js` (`processSheet`). The Python backend
(`backend/app/ccr_parse.py`) is a **line-by-line port** of it so that rows stored
in Postgres are byte-identical to the browser pipeline. Derived scores
(discipline, risk, ranking, insights) intentionally stay in the browser so
business logic parity is guaranteed.

The browser uses **two read paths** (both require a signed-in user):

- **Summary fast path** — one RPC (`get_ccr_dashboard`) returns per-DSE-day
  accumulator rows + filter options + meta. `metrics.js: hydrateDailyRows()`
  expands them into the same `dailyMap` the xlsx pipeline builds.
- **Row-level path** — the FastAPI `/api/visits` endpoint (one gzip request,
  ~10× smaller transfer, no PostgREST gateway limit) feeds the modules that need
  individual visits: Store Time, Geography, Risk/DSE profiles and the standalone
  HTML export. Fallback when the backend isn't reachable: `get_ccr_visits` RPCs
  sliced by date, in parallel.

**Access control:** users sign in with Supabase Auth (email/password). There is
**1 admin** (may import/process data) and **7 viewers** (read-only). Roles live
in `public.user_roles`; RLS + JWT verification enforce them. See Step F.

---

## 2. Component inventory

| Layer | File(s) | Purpose |
|---|---|---|
| DB schema | `supabase/migrations/0001_ccr_schema.sql` | `ccr_import_jobs`, `ccr_raw`, RLS, indexes, `get_ccr_dashboard` v1 |
| DB perf/RPC | `supabase/migrations/0002_ccr_perf.sql` | statement timeouts and `get_ccr_dashboard` v2 |
| DB perf fix | `supabase/migrations/0003_visits_json.sql` | `get_ccr_visits` returns `json` (not `jsonb`) → ~10× faster |
| DB auth | `supabase/migrations/0004_auth.sql` | `user_roles`, `is_admin()`, `get_my_role()`, anon revoke, admin-only writes |
| DB access log | `supabase/migrations/0005_access_log.sql` | `access_log` table, `log_access()`, admin-only `get_access_report()` (daily usage) |
| Backend app | `backend/app/main.py` | FastAPI: import, jobs, visits, health (auth-gated) |
| Backend auth | `backend/app/auth.py` | Verifies Supabase JWTs; `require_user` / `require_admin` |
| Backend DB | `backend/app/db.py` | psycopg3 pool, COPY import, `/api/visits` query, role lookup, PostgREST fallback |
| Backend parse | `backend/app/ccr_parse.py` | Python port of `data.js: processSheet` |
| Backend xlsx | `backend/app/xlsxio.py` | Minimal XLSX reader matching SheetJS `sheet_to_json` |
| Backend config | `backend/app/config.py`, `backend/.env` | Env loading (incl. `SUPABASE_JWT_SECRET`) |
| Import script | `backend/scripts/import_rest.py` | Import via PostgREST + service_role key (no DB URL needed) |
| Provisioning | `backend/scripts/provision_users.py` | Create 1 admin + 7 viewers, stamp roles |
| Frontend config | `dashboard/config.js` | Supabase URL/anon key, `apiBase`, optional import token |
| Frontend auth | `dashboard/js/auth.js` | GoTrue sign-in/out, session + refresh, role, 401 handling |
| Frontend service | `dashboard/js/ccrService.js` | RPC calls (with user token), caching, visit slicing, upload |
| Frontend wiring | `dashboard/js/app.js` | login gating, `applyRoleUI()`, `loadSupabase()`, `uploadToSupabase()` |
| Parity tests | `tests/parity_*.js`, `tests/parity_pipeline.js` | Verify Python/JS/RPC produce identical output (login-aware) |

---

## 3. Data flow

### 3.1 Import (write path)

Only the **admin** may trigger an import (browser upload requires the admin
JWT; `import_rest.py` uses the service_role key).

```
xlsx file
  → upload spooled to a temp file (1MB chunks, hashed on the way) — the
    workbook itself is never held in RAM
  → xlsxio.iter_rows(path)           # rows yielded one at a time (SheetJS parity)
  → ccr_parse.process_sheet(rows, sink=write)   # normalize + validate → report
  → db.visit_writer(job_id) write()  # COPY bulk insert, chunk by chunk
  → ccr_import_jobs row COMPLETED + active=true
```

The whole import is streamed (rows off disk → visits into COPY), so peak memory
stays flat (~55MB measured on the 23MB / 85k-row MTD_CCR.xlsx) instead of
materializing every row twice — the free Render instance is capped at 512MB.
`xlsxio.sheet_rows()` / `ccr_parse.process_sheet(list)` (no sink) still return
full lists for the offline scripts and the parity tests.

The upload request only spools the file and starts a worker thread: `POST
/api/import` responds immediately with the job in `PROCESSING`, and the
dashboard polls `GET /api/jobs/{id}` until `COMPLETED`/`FAILED` (Render kills
HTTP requests long before a real workbook finishes loading). Before the job is
marked `COMPLETED` the worker runs `VACUUM (ANALYZE) public.ccr_raw`, so the
planner stats are fresh by the time the browser starts loading the dashboard.

Exactly one job is `active` at a time (partial unique index
`ccr_import_jobs_one_active`). Activating a new import deactivates the previous
one. Re-uploading the same file (same `file_hash`) is **idempotent** — the
existing job is simply re-activated, no re-insert.

### 3.2 Read (dashboard path)

```
browser computeSupabase()
  → POST /rest/v1/rpc/get_ccr_dashboard (anon key + Bearer <user token>)
      → daily[], options{}, meta{}
  → metrics.hydrateDailyRows(daily) → dailyMap
  → buildDSE / computeBenchmarks / computeRisk / computeRanking
  → render active module

background startVisitsLoad()
  → GET {apiBase}/api/visits (gzip, preferred)
      (fallback: get_ccr_visits RPCs in parallel date slices)
  → state.filteredVisits → Spend / Geo / Risk / DSE-profile / export
```

> **Performance note.** Row-level modules (Geography, Risk, Store Time, DSE
> profiles) need *every* visit, so on a full-month import they move ~14 MB
> gzipped / ~174 MB decompressed. The summary tabs stay fast because
> `get_ccr_dashboard` is pre-aggregated. To cut load time:
> 1. **Host the backend in the same region as the DB** (default is
>    `ap-northeast-1`/Tokyo) — the DB→backend hop is the bulk of the time.
> 2. **Narrow the date filter** before opening a row-level module.
> 3. The backend gzip path is ~3× faster than the sliced RPCs and avoids the
>    PostgREST gateway timeout on the full range.

All filters (date range, branch location, ZSM, ASM, ASO, DSE, channel,
on-route) are applied **server-side** with the same AND semantics as
`app.js: filterVisits`.

---

## 4. Prerequisites

- A **Supabase project** (free tier is enough to start; a paid tier helps for
  170k+ row imports and the `get_ccr_visits` response size).
- **Node.js** (for the static local server / build scripts).
- **Python 3.10+** with `pip` (for the FastAPI backend and import script).
- The source workbook (`Input/MTD_CCR.xlsx` or `MTD CCR 25.08.xlsx`).

---

## 5. Setup — step by step

### Step A — Create the Supabase project and schema

1. Create a project at <https://supabase.com> and note:
   - **Project URL** → `https://<project-ref>.supabase.co`
   - **anon / publishable key** (safe for the browser)
   - **service_role key** (server-side only — never ship this to the browser)
   - **Database connection string** (Dashboard → Connect → Session pooler) →
     `postgresql://...` (used for the COPY fast path)

2. Open the **SQL Editor** and run the migrations **in order** by pasting the
   whole file each time:

   ```
   supabase/migrations/0001_ccr_schema.sql
   supabase/migrations/0002_ccr_perf.sql
   supabase/migrations/0003_visits_json.sql
   ```

   `0002` and `0003` raise the API statement timeout and (re)define the two RPCs.
   `0003` swaps `get_ccr_visits` to return `json` instead of `jsonb`; on a large
   import this changes a full read from ~80 s (timeout) to a few seconds.

3. Confirm Row Level Security: at this point (before `0004_auth.sql`)
   `ccr_raw` and `ccr_import_jobs` are readable by `anon`/`authenticated` and
   writable only by the service role. Migration `0004` (Step F) then **revokes
   anon reads** so a login is required.

### Step B — Configure and run the backend

1. Create `backend/.env` from the example:

   ```powershell
   Copy-Item backend\.env.example backend\.env
   ```

   Fill in (see §7 for the full list):

   ```
   SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   SUPABASE_ANON_KEY=<anon key>
   SUPABASE_JWT_SECRET=<JWT secret>   # legacy HS256 only; ES256 uses JWKS
   CCR_IMPORT_TOKEN=<optional shared secret>
   ALLOWED_ORIGINS=*
   MAX_UPLOAD_MB=200
   ```

   - `SUPABASE_DB_URL` enables the fast COPY import path **and** the `/api/visits`
     Postgres query. Without it, imports must use `import_rest.py` and `/api/visits`
     falls back to PostgREST.
   - The backend needs **no** external deps beyond `requirements.txt`.

2. Install and start:

   ```powershell
   pip install -r backend\requirements.txt
   python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
   ```

   (If importing fails because `backend` is not a package path, run from the
   repo root with `python -m uvicorn app.main:app --app-dir backend`.)

3. Verify: `GET http://localhost:8000/api/health` →
   `{"ok": true, "db": true, "rest": true}`.

### Step C — Point the dashboard at the live DB

Edit `dashboard/config.js` (or override at runtime with
`window.__CCR_CONFIG__` before the file loads):

```js
window.__CCR_CONFIG__ = Object.assign({
  supabaseUrl:    'https://<ref>.supabase.co',   // no trailing slash
  supabaseAnonKey: '<anon key>',                 // safe to expose
  apiBase:        'http://localhost:8000',       // FastAPI origin
  importToken:    ''                             // only if CCR_IMPORT_TOKEN is set
}, window.__CCR_CONFIG__ || {});
```

- **Leave `supabaseUrl`/`supabaseAnonKey` empty** to keep the app fully local
  (xlsx-only mode). The "Load from Supabase" button only appears when they are set.
- The **"Upload .xlsx to server…"** button only appears when `apiBase` is set.

### Step D — Import data (choose one)

**Option 1 — In the dashboard (recommended for daily use).**
Sign in as the **admin**, click **Load MTD Data** → **Upload .xlsx to server…**,
pick the workbook. The backend parses it, inserts the rows and activates the
import; the dashboard then loads from Supabase. Requires the backend running,
`apiBase` set, and an admin session (viewers have no upload button).

**Option 2 — Command line via PostgREST (`import_rest.py`).**
Use this when you have only the URL + service_role key (no `SUPABASE_DB_URL`):

```powershell
python backend\scripts\import_rest.py "G:\profile\Desktop\CCR_analysis\MTD CCR 25.08.xlsx"
# options: --dry-run, --batch 2000, --url ..., --key ...
```

It parses locally, batch-inserts into `ccr_raw`, and activates the job. Same
identity/idempotency rules as the API.

**Option 3 — HTTP upload with `curl`.**

```powershell
curl.exe -X POST "http://localhost:8000/api/import" `
  -H "X-Import-Token: <token if set>" `
  -F "file=@MTD CCR 25.08.xlsx"
```

Then `GET /api/jobs/{id}` for status, or `GET /api/jobs` for recent jobs.

### Step E — Load the dashboard from the DB

On startup, `app.js` auto-calls `loadSupabase()` when Supabase is configured.
You can also click **Load from Supabase** in the load panel. The status bar
(`#srcInfo`) shows the source + row/DSE counts once loaded.

> Once auth is enabled (Step F), the app **always shows the login screen
> first** in live-DB mode — a signed-in session (any role) is required to read
> any data.

### Step F — Enable login with 1 admin + 7 viewers

1. Run migration **`supabase/migrations/0004_auth.sql`** in the SQL Editor.
   It:
   - creates `public.user_roles` (`user_id`, `email`, `role` in
     `admin`/`viewer`);
   - adds security-definer helpers `is_admin()` and `get_my_role()`;
   - **revokes the `anon` role** from `ccr_raw`, `ccr_import_jobs` and both
     RPCs, then grants `authenticated` read access + `get_my_role` — so from
     now on **every data read requires a logged-in user**;
   - locks down writes: only an admin may INSERT/UPDATE/DELETE on the data
     tables (service role still bypasses RLS for server-side imports).

   Optionally run **`supabase/migrations/0005_access_log.sql`** too: it creates
   `public.access_log` plus `log_access()` / `get_access_report()` so the admin
   can monitor per-day viewer activity (admin **Activity** button, CSV/XLSX).

2. **Token verification:** newer Supabase projects sign access tokens with
   **ES256** asymmetric keys, verified via the project's JWKS endpoint — the
   backend only needs `SUPABASE_URL` for that (nothing to add). Only **legacy
   HS256** projects need the JWT secret in `backend/.env`:
   ```
   SUPABASE_JWT_SECRET=<the 40-char base64 secret>   # HS256 projects only
   ```
   (If in doubt: sign in, decode the token's header — `"alg":"ES256"` means
   JWKS, `"alg":"HS256"` means the secret.)

3. Create the users (provisioning script — needs the **real service_role
   key**, copies win):

   ```powershell
   python backend\scripts\provision_users.py `
     --admin admin@example.com --viewers 7 `
     --password "CCR-Admin@123"
   ```

   The script signs each account up in Supabase Auth
   (`email_confirm: true`, password auth), stamps the role into
   `app_metadata.ccr_role`, and upserts `public.user_roles`. It writes the
   credentials to `backend/.users.json` and prints a table like
   `viewer1@example.com` … `viewer7@example.com`. Passwords are set in one
   step (all accounts) — share them per user, or extend the script once
   per-user passwords are needed.

   > Without a valid service_role key the script exits with an HTTP 401 —
   > the key in `backend/.env` must be the *service* key, **not** the anon key.

4. Sign in at the dashboard. The login overlay appears automatically in
   live-DB mode. The **admin** sees the **"Upload .xlsx to server…"**, which
   calls the now-admin-only `POST /api/import`; the **viewers** see a
   read-only dashboard (reload from Supabase, export, filters) with no import
   controls.

---

## 6. Endpoints & RPC reference

### Frontend RPCs (sent with the signed-in user's token)

After migration `0004`, the anon key alone is **no longer accepted**: every
call carries `Authorization: Bearer <user access token>` (added automatically
by `dashboard/js/auth.js` + `ccrService.js`).

| RPC | Params | Returns |
|---|---|---|
| `get_ccr_dashboard` | `p_date_from, p_date_to, p_branch_locs[], p_zsms[], p_asms[], p_asos[], p_dse_codes[], p_channels[], p_on_route` | `{ daily[], options{branchLocs,zsms,asms,asos,channels,dses}, meta{date_min,date_max,total_visits,has_data,report,import} }` |
| `get_ccr_visits` | same as above | array of normalized visit objects, ordered `(business_date, id)` |
| `get_my_role` | `{}` | the current user's role string, `'admin'` or `'viewer'` |

### FastAPI backend

Authenticated with the same JWT, verified against the project's JWKS
(`SUPABASE_URL`) for ES256/RS256 tokens, or `SUPABASE_JWT_SECRET` for legacy
HS256. `/api/import` additionally requires the **admin** role (or the legacy
`X-Import-Token`); the rest require any signed-in user.

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | public | `{ok, db, rest}` readiness |
| `POST` | `/api/import` | **admin only** (or `X-Import-Token`) | multipart xlsx → import job (`?force=1` to bypass hash idempotency) |
| `GET` | `/api/jobs?limit=` | signed-in user | recent import jobs |
| `GET` | `/api/jobs/{id}` | signed-in user | one job's status/report |
| `GET` | `/api/visits` | signed-in user | gzip JSON row-level visits, same filter semantics as the RPCs |

`/api/visits` responds with `Content-Encoding: gzip` (the browser inflates it
transparently). `x-payload-encoding: gzip` is set for non-browser clients.

---

## 7. Environment variables (`backend/.env`)

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | recommended | Postgres connection string → COPY import + direct `/api/visits` |
| `SUPABASE_URL` | yes (REST mode) | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (REST mode) | Server-side only. Never in the browser |
| `SUPABASE_ANON_KEY` | no | Only if a script needs the public key |
| `SUPABASE_JWT_SECRET` | only HS256 | Legacy projects. ES256/RS256 projects verify via JWKS (`SUPABASE_URL`) instead |
| `CCR_IMPORT_TOKEN` | no | Shared secret required in `X-Import-Token` for `/api/import` |
| `ALLOWED_ORIGINS` | no | CORS allow-list, default `*` |
| `MAX_UPLOAD_MB` | no | Upload cap, default `200` |

Frontend (`dashboard/config.js`): `supabaseUrl`, `supabaseAnonKey`, `apiBase`,
`importToken`. Only `supabaseUrl` + `supabaseAnonKey` are ever exposed to the
browser, and both are meant to be public. Access control comes from the **user
login** (GoTrue session in localStorage), not from hiding the anon key.

---

## 8. Running locally

```powershell
# 1) Backend (live DB import + /api/visits fallback)
python -m uvicorn backend.app.main:app --port 8000

# 2) Static dashboard server
node server.js          # serves http://localhost:8123/dashboard/
#   or: start_dashboard.bat
```

Open <http://localhost:8123/dashboard/>. With `config.js` filled in, it loads
from Supabase automatically.

> The standalone/offline build still works and is unrelated to the live path:
> `node dashboard/build_single.cjs` embeds a compact gzip representation of the
> visits into a single HTML file (no DB needed).

---

## 9. Deploying

- **Dashboard** (`dashboard/` or the generated `dist/`): any static host
  (Netlify, Pages, S3). Set `supabaseUrl`/`supabaseAnonKey` in `config.js`.
  Because the anon key is public, **RLS is the security boundary**.
- **Backend** (`backend/`): any Python host (Render, Fly, Railway, a VM).
  Set the env vars, run `uvicorn`. Set `apiBase` in `config.js` to its origin
  and restrict `ALLOWED_ORIGINS` in production.
- See `NETLIFY_DEPLOY_GUIDE.md` for the static deploy workflow.

---

## 10. Verification

Parity tests exist to prove the DB path equals the browser path. Once migration
`0004` is applied, the live test **must sign in first** — set these env vars to
a logged-in account:

```powershell
$env:CCR_TEST_EMAIL="viewer1@example.com"; $env:CCR_TEST_PASSWORD="CCR-Admin@123"
node tests/parity_live.js
```

Unset them and the parity runner warns it is calling the RPCs anonymously.

```powershell
node tests/parity_pipeline.js
node tests/parity_hydrate.js
```

They write `tests/visits_js.json`, `tests/visits_py.json`,
`tests/visits_api.json` and `tests/report_js.json` / `report_py.json`. Compare
the reports for byte-identical `totalRows` / `validRows` and matching visit
values. Run these **after** any change to `data.js`, `ccr_parse.py`, or the RPCs.

Manual smoke check:

1. Sign in as the **admin** → import a workbook (Option 1/2/3).
2. `GET /api/jobs` shows a `COMPLETED`, `active=true` job.
3. Sign in as a **viewer** in a second tab → no upload button; KPI counts match.
4. Switch filters → the summary RPC re-runs and the numbers change consistently.

---

## 11. Security notes

- **Access = the user's login, not a hidden key.** The anon key is public by
  design. Migration `0004` revokes `anon` from the data tables and RPCs, so
  reads require a signed-in user; the backend rejects any access token it
  cannot verify with `SUPABASE_JWT_SECRET`.
- **Roles:** `admin` (1 account) may *process* the data — `POST /api/import`
  is admin-only, and RLS keeps data-table writes to admins. `viewer` (7
  accounts) can read the dashboard, reload, filter and export only.
- The **service_role key must never reach the browser**. It lives only in
  `backend/.env` and is used by the backend / `import_rest.py` /
  `provision_users.py`.
- Sessions are JWTs in `localStorage` (`ccr.auth`); a 401 from any data call
  clears the session and forces the login screen. Tokens auto-refresh 60 s
  before expiry.
- Set a strong user password for the seeded accounts, `CCR_IMPORT_TOKEN`, and a
  tight `ALLOWED_ORIGINS` before exposing the backend publicly.

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Load from Supabase" button missing | `supabaseUrl`/`supabaseAnonKey` empty in `config.js` |
| "Supabase has no data yet" | No active completed import — import a workbook first |
| `get_ccr_visits` times out / Cloudflare 520 | Run migrations `0002` + `0003`; the RPC must return `json`, and slices must stay under the gateway limit |
| Dashboard summary times out on a big import | `0002` raises `statement_timeout`; verify all three roles (`anon`, `authenticated`, `authenticator`) were altered |
| Import fails with `SUPABASE_DB_URL is not configured` | Either set `SUPABASE_DB_URL` **or** import via `import_rest.py` |
| `/api/visits` returns 503/error | Backend lacks DB URL and REST credentials, or the app has no active import |
| Rows differ between xlsx view and DB view | A change to `data.js`/`ccr_parse.py`/RPC drifted — re-run parity tests |
| CORS error in the browser | Backend `ALLOWED_ORIGINS` doesn't include the dashboard origin |
| Re-upload made no difference | Same `file_hash` → idempotent re-activation. Use `?force=1` to re-import |
| Login screen keeps reappearing / "Session expired" | Token stale or revoked — sign in again |
| Import returns **503** "SUPABASE_JWT_SECRET is not configured" | An **HS256** project without the secret. For ES256 projects this shouldn't happen — confirm the token header `alg` and that `SUPABASE_URL` is set (JWKS) |
| Login fails with "Invalid login credentials" | User not created, or wrong password — re-run `provision_users.py` |
| Viewer sees "Only the admin can process…" (403) | Correct — import is admin-only. Sign in with the admin account to import |
| `provision_users.py` exits with HTTP 401 | `SUPABASE_SERVICE_ROLE_KEY` is actually the anon key (or rotated post-pause). Use the real service key |
| RPC 401/403 after adding `0004_auth.sql` | Expected: anon can no longer read. Sign in (the RPCs now require an authenticated token) |

---

## 13. Current status & next steps

**Already implemented**

- Supabase schema, indexes and RLS for `ccr_raw` + `ccr_import_jobs`.
- `get_ccr_dashboard` (summary) and `get_ccr_visits` (row-level) RPCs.
- FastAPI backend: import jobs, row-level visits, health; psycopg COPY + PostgREST fallback.
- `import_rest.py` for service-role imports.
- Browser `ccrService.js` + `config.js`, wired into `app.js` (auto-load, upload, background visit loading).
- Python↔JS parse parity tests.
- **Auth (migration `0004_auth.sql`):** roles (`user_roles`), `is_admin()`/`get_my_role()`, anon revoked, RLS write-locks, admin-only import.
- **Backend JWT auth** (`backend/app/auth.py`): verifies Supabase access tokens, `/api/import` requires admin, other endpoints require a signed-in user.
- **Frontend login** (`dashboard/js/auth.js` + `app.js`): GoTrue email/password, session + auto-refresh, login overlay, user chip, role-gated import controls, 401 → re-login.
- **Provisioning** (`backend/scripts/provision_users.py`): 1 admin + 7 viewers.
- **Viewer activity (migration `0005_access_log.sql`):** every app-open by a signed-in user is recorded (`log_access()`, one row per page load). The admin-only **Activity** button (`app.js` → `openAccessReport`) shows a per-day / per-user table (visits, first/last seen) with **Export CSV / XLSX**, backed by the admin-only `get_access_report()` RPC. Viewers can write their own visit but cannot read the log.

**Recommended next steps**

1. Move secrets to your host's env manager; keep `backend/.env` out of git.
2. Add a `ccr_summary` materialized table only if `EXPLAIN ANALYZE` shows
   `get_ccr_dashboard` is a bottleneck (currently not needed).
3. Add scheduled/automated daily import (cron + `import_rest.py`, or a backend
   worker) so data freshness is hands-off.
4. Add per-user passwords in the provisioning step (currently one shared
   password) and a "reset password" flow.
5. Pin the frontend's `config.js` per environment (local vs prod `apiBase`).

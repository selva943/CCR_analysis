# Set up a replacement Supabase project

This procedure creates an **empty** database for the CCR dashboard. It does not
copy data or remove the old project. Keep the old project until the new one has
been tested and the dashboard has loaded an import successfully.

## Before creating the project

The old project reported database disk exhaustion and repeated PostgreSQL
restarts. The organization also reported a billing-cycle quota overage. Check
and resolve the organization quota first: creating another project in the same
organization may be blocked or may not resolve an organization-level limit.
Choose database capacity with enough headroom for the raw visits and indexes;
the current import alone contains over 150,000 rows.

## 1. Create the Supabase project

In the Supabase dashboard, create a project in an organization that can host it.
Save the database password securely. Do not put database passwords,
`service_role` keys, or connection strings in this repository or in browser
configuration.

From the new project's **Connect** and **API Keys** pages, collect:

- Project URL
- Publishable/anon key
- `service_role` key (server-side only)
- Direct or session-pooler PostgreSQL connection string for the backend

## 2. Initialize the empty schema

In the new project's SQL Editor, paste and run
[`supabase/setup_new_project.sql`](./supabase/setup_new_project.sql) once. It
combines migrations `0001` through `0007` in dependency order, including the
optimized `get_ccr_visits` function. It creates the schema and policies only;
it does not import CCR data.

Alternatively, run the individual migrations in order, waiting for success
after each:

1. `supabase/migrations/0001_ccr_schema.sql`
2. `supabase/migrations/0002_ccr_perf.sql`
3. `supabase/migrations/0003_visits_json.sql`
4. `supabase/migrations/0004_auth.sql`
5. `supabase/migrations/0005_access_log.sql`
6. `supabase/migrations/0006_anon_read.sql`
7. `supabase/migrations/0007_access_log_local.sql`

Use either the combined file or the individual migrations, not both. `0002`
defines the dashboard summary RPC and API timeouts; `0003` installs the
optimized `get_ccr_visits` RPC with its `json` return type.

Confirm that both RPCs exist with the expected return types:

```sql
select
  to_regprocedure(
    'public.get_ccr_dashboard(date,date,text[],text[],text[],text[],text[],text[],text)'
  ) as dashboard_rpc,
  to_regprocedure(
    'public.get_ccr_visits(date,date,text[],text[],text[],text[],text[],text[],text)'
  ) as visits_rpc;

select
  p.proname,
  pg_get_function_result(p.oid) as result_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_ccr_dashboard', 'get_ccr_visits')
order by p.proname;
```

Expected results are `jsonb` for `get_ccr_dashboard` and `json` for
`get_ccr_visits`.

## 3. Point the backend and dashboard at the new project

Update the existing Render service's environment variables, keeping their
values in Render's secret settings:

- `SUPABASE_URL` — new project URL
- `SUPABASE_SERVICE_ROLE_KEY` — new project's service-role key
- `SUPABASE_DB_URL` — new project's PostgreSQL connection string
- Keep the existing `CCR_IMPORT_TOKEN` unchanged so the admin import UI still
  matches the backend token.

Update `dashboard/config.js` with the new project URL and anon key. Do not put
the service-role key or database connection string there. Deploy the backend
and dashboard after updating their configuration.

## 4. Import and verify

Once the backend is healthy and the new database accepts connections, use the
dashboard's admin upload flow to import the current workbook. This starts the
new database empty and does not require copying old import history.

Verify that:

- The backend health endpoint reports database connectivity.
- The new project's `ccr_import_jobs` contains one completed active import.
- The dashboard loads its summary and row-level visit data.
- The dashboard's filters and a visit-dependent page work.
- The Supabase project has sufficient disk headroom after the import.

Keep the old project until these checks pass. Only then decide whether to
decommission it.

## Access-control note

This preserves the current employee login **interface**, not database-level
authentication. The current login is implemented in the browser, and migration
`0006_anon_read.sql` grants the `anon` role read access to dashboard data. Anyone
who obtains the project URL and public anon key can call the read RPCs directly;
the browser login is not a security boundary. If the data must be restricted to
logged-in employees, do not use this anon-readable setup as-is—design and test
server-verified authentication and database policies before importing data.

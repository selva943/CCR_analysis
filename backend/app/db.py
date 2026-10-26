"""Postgres access layer (psycopg 3 pool + COPY import + job bookkeeping)."""
from __future__ import annotations

import gzip
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from . import config

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        if not config.DATABASE_URL:
            raise RuntimeError('SUPABASE_DB_URL (DATABASE_URL) is not configured')
        _pool = ConnectionPool(
            config.DATABASE_URL,
            min_size=1,
            max_size=6,
            kwargs={'row_factory': dict_row, 'application_name': 'ccr-backend'},
            open=True,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def conn() -> Iterator[psycopg.Connection]:
    with get_pool().connection() as c:
        yield c


def _jsonify(v: Any) -> Any:
    if isinstance(v, Decimal):
        f = float(v)
        return f if f == f and abs(f) != float('inf') else None
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _row(r: dict) -> dict:
    return {k: _jsonify(v) for k, v in r.items()}


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------

def create_job(file_name: str, file_hash: str, imported_by: str | None) -> dict:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            '''insert into public.ccr_import_jobs (file_name, file_hash, status, imported_by)
               values (%s, %s, 'PENDING', %s) returning *''',
            (file_name, file_hash, imported_by))
        return _row(cur.fetchone())


def find_job_by_hash(file_hash: str) -> dict | None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            '''select * from public.ccr_import_jobs
               where file_hash = %s and status = 'COMPLETED'
               order by completed_at desc limit 1''', (file_hash,))
        r = cur.fetchone()
        return _row(r) if r else None


def mark_processing(job_id: str) -> None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            '''update public.ccr_import_jobs
               set status = 'PROCESSING', started_at = now(), error_message = null
               where id = %s''', (job_id,))


def update_job_progress(job_id: str, processed_rows: int) -> None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            '''update public.ccr_import_jobs
               set processed_rows = %s
               where id = %s and status = 'PROCESSING' ''',
            (processed_rows, job_id))


def fail_job(job_id: str, error: str, report: dict | None = None,
             total_rows: int | None = None, failed_rows: int | None = None) -> dict:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            '''update public.ccr_import_jobs
               set status = 'FAILED', error_message = %s,
                   report = coalesce(%s::jsonb, report),
                   total_rows = coalesce(%s, total_rows),
                   failed_rows = coalesce(%s, failed_rows),
                   completed_at = now()
               where id = %s''',
            (error, _psycopg_json(report), total_rows, failed_rows, job_id))
        cur.execute('select * from public.ccr_import_jobs where id = %s', (job_id,))
        return _row(cur.fetchone())


def _psycopg_json(v: dict | None):
    if v is None:
        return None
    import json as _json
    from psycopg.types.json import Jsonb
    return Jsonb(v)


def vacuum_analyze() -> None:
    """Refresh planner stats right after a big import (own autocommit
    connection — VACUUM may not run inside a transaction block, and the pool's
    session must stay clean). Autovacuum would get to this eventually, but the
    browser starts loading the dashboard the moment the job goes COMPLETED, and
    with stale stats the visit RPCs on the 1M+ row table can blow their
    statement timeout."""
    with psycopg.connect(config.DATABASE_URL, autocommit=True,
                         application_name='ccr-backend-vacuum') as c:
        with c.cursor() as cur:
            cur.execute('vacuum (analyze) public.ccr_raw')


def complete_job(job_id: str, report: dict, total_rows: int, processed_rows: int,
                 failed_rows: int, activate: bool = True) -> dict:
    with conn() as c, c.transaction():
        with c.cursor() as cur:
            if activate:
                cur.execute('update public.ccr_import_jobs set active = false where active')
            cur.execute(
                '''update public.ccr_import_jobs
                   set status = 'COMPLETED', active = %s, report = %s,
                       total_rows = %s, processed_rows = %s, failed_rows = %s,
                       completed_at = now()
                   where id = %s''',
                (activate, _psycopg_json(report), total_rows, processed_rows,
                 failed_rows, job_id))
            cur.execute('select * from public.ccr_import_jobs where id = %s', (job_id,))
            return _row(cur.fetchone())


def get_job(job_id: str) -> dict | None:
    with conn() as c, c.cursor() as cur:
        cur.execute('select * from public.ccr_import_jobs where id = %s', (job_id,))
        r = cur.fetchone()
        return _row(r) if r else None


def reactivate_job(job_id: str) -> dict | None:
    """Make an already-imported job the active one (rows are kept per import_id,
    so re-activating is a metadata-only flip)."""
    with conn() as c, c.transaction():
        with c.cursor() as cur:
            cur.execute('update public.ccr_import_jobs set active = false where active and id <> %s',
                        (job_id,))
            cur.execute('update public.ccr_import_jobs set active = true where id = %s',
                        (job_id,))
    return get_job(job_id)


def list_jobs(limit: int = 20) -> list[dict]:
    with conn() as c, c.cursor() as cur:
        cur.execute('select * from public.ccr_import_jobs order by created_at desc limit %s',
                    (limit,))
        return [_row(r) for r in cur.fetchall()]


def get_active_job() -> dict | None:
    with conn() as c, c.cursor() as cur:
        cur.execute(
            '''select * from public.ccr_import_jobs
               where active and status = 'COMPLETED'
               order by completed_at desc limit 1''')
        r = cur.fetchone()
        return _row(r) if r else None


# --------------------------------------------------------------------------
# Roles (user_roles)
# --------------------------------------------------------------------------

def get_user_role(user_id) -> str | None:
    """Role of a user via the direct Postgres connection (RLS bypassed)."""
    with conn() as c, c.cursor() as cur:
        cur.execute(
            'select role from public.user_roles where user_id = %s', (user_id,))
        r = cur.fetchone()
        return r['role'] if r else None


def rest_get_user_role(user_id: str) -> str | None:
    """Role lookup over PostgREST with the service_role key (no DB URL)."""
    base, key = config.SUPABASE_URL, config.SERVICE_ROLE_KEY
    if not base or not key:
        return None
    data = _rest_get('user_roles', [
        ('select', 'role'), ('user_id', 'eq.' + user_id), ('limit', '1')])
    return data[0]['role'] if data else None


# --------------------------------------------------------------------------
# Visit COPY
# --------------------------------------------------------------------------

COPY_COLS = (
    'import_id', 'business_date', 'date_obj',
    'branch_code', 'branch_location', 'dse_code', 'dse_name', 'zsm', 'asm', 'aso',
    'route_name',
    'retailer_code', 'retailer_name', 'contact_1', 'contact_2',
    'channel_name', 'channel', 'sub_channel', 'in_market_status',
    'day_start_min', 'start_min', 'end_min', 'intime_min', 'duration_min',
    'distance', 'order_value', 'calls_made',
    'productivity', 'productivity_raw', 'call_compliance', 'below_5',
    'on_route', 'on_route_raw', 'deviation_m', 'deviation_flag',
    'reason_for_deviation', 'reason', 'remarks',
    'latitude', 'longitude',
    'visit_p1m', 'visit_p3m', 'visit_ipdp',
    'is_valid', 'dup_key', 'source_file',
)


def _copy_value(field: str, v: Any) -> Any:
    if field == 'business_date':
        return date.fromisoformat(v)
    return v


def _write_batch(cur, batch: list[dict], job_id: str, source_file: str,
                 fields: tuple[str, ...]) -> None:
    with cur.copy(
        'copy public.ccr_raw (' + ', '.join(fields) + ') from stdin'
    ) as cp:
        for v in batch:
            row = []
            for f in fields:
                if f == 'import_id':
                    row.append(uuid.UUID(job_id))
                    continue
                if f == 'source_file':
                    row.append(source_file)
                    continue
                if f == 'is_valid':
                    row.append(bool(v.get('_is_valid', True)))
                    continue
                if f == 'dup_key':
                    row.append(v.get('_dup_key'))
                    continue
                if f == 'business_date':
                    row.append(date.fromisoformat(v['date']))
                    continue
                val = v.get(f if f != 'date_obj' else 'dateObj')
                if isinstance(val, float) and not (
                        val == val and abs(val) != float('inf')):
                    val = None  # NaN/Infinity → NULL (JSON.stringify parity)
                row.append(val)
            cp.write_row(tuple(row))


@contextmanager
def visit_writer(job_id: str, source_file: str, chunk: int = 10000
                 ) -> Iterator[Callable[[dict], None]]:
    """Streaming COPY of visits into ccr_raw (one transaction, `chunk` rows
    per COPY statement).

    Yields a `write(visit)` callable so the parser can hand visits over one at
    a time — the whole import never has to be held in memory. If the body
    raises, the transaction rolls back and nothing is written.
    """
    fields = COPY_COLS
    with conn() as c, c.transaction():
        with c.cursor() as cur:
            batch: list[dict] = []

            def write(v: dict) -> None:
                batch.append(v)
                if len(batch) >= chunk:
                    _write_batch(cur, batch, job_id, source_file, fields)
                    batch.clear()

            yield write
            if batch:
                _write_batch(cur, batch, job_id, source_file, fields)


def copy_visits(job_id: str, visits: Iterable[dict], source_file: str,
                chunk: int = 10000) -> None:
    """Stream visits into ccr_raw with COPY (fast bulk insert).

    Accepts any iterable — a list (legacy callers) or a generator.
    """
    with visit_writer(job_id, source_file, chunk=chunk) as write:
        for v in visits:
            write(v)


# --------------------------------------------------------------------------
# /api/visits query
# --------------------------------------------------------------------------

_VISIT_FIELDS = (
    'date', 'dateObj', 'branch_code', 'branch_location', 'dse_code', 'dse_name',
    'zsm', 'asm', 'aso', 'route_name', 'retailer_code', 'retailer_name',
    'contact_1', 'contact_2', 'channel_name', 'channel', 'sub_channel',
    'in_market_status', 'day_start_min', 'start_min', 'end_min', 'intime_min',
    'duration_min', 'distance', 'order_value', 'calls_made', 'productivity',
    'productivity_raw', 'call_compliance', 'below_5', 'on_route', 'on_route_raw',
    'deviation_m', 'deviation_flag', 'reason_for_deviation', 'reason', 'remarks',
    'latitude', 'longitude', 'visit_p1m', 'visit_p3m', 'visit_ipdp',
)


def query_visits(filters: dict) -> list[dict]:
    """Row-level visits for the active import, browser filter semantics,
    ordered like the browser pipeline (business_date asc, id asc).

    Uses Postgres/COPY when DATABASE_URL is set; falls back to PostgREST with
    the service_role key when only SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
    are available."""
    if not config.DATABASE_URL:
        return rest_query_visits(filters)
    where = ['r.import_id = (select id from public.ccr_import_jobs '
             'where active and status = \'COMPLETED\' order by completed_at desc limit 1)']
    args: list[Any] = []

    def arr(name: str, col: str) -> None:
        v = filters.get(name) or []
        if v:
            where.append(f'r.{col} = any(%s)')
            args.append(list(v))

    if filters.get('date_from'):
        where.append('r.business_date >= %s')
        args.append(filters['date_from'])
    if filters.get('date_to'):
        where.append('r.business_date <= %s')
        args.append(filters['date_to'])
    arr('branch_locs', 'branch_location')
    arr('zsms', 'zsm')
    arr('asms', 'asm')
    arr('asos', 'aso')
    arr('dse_codes', 'dse_code')
    arr('channels', 'channel')
    on_route = filters.get('on_route') or 'ALL'
    if on_route not in ('ALL', ''):
        where.append('r.on_route = %s')
        args.append(on_route)

    cols = ', '.join(
        ('to_char(r.business_date, \'YYYY-MM-DD\') as "date"' if f == 'date'
         else f'r.{f} as "{f}"' if f != 'dateObj' else 'r.date_obj as "dateObj"')
        for f in _VISIT_FIELDS)
    sql = (f'select {cols} from public.ccr_raw r where '
           + ' and '.join(where) + ' order by r.business_date, r.id')
    with conn() as c, c.cursor() as cur:
        cur.execute(sql, args)
        out = []
        for r in cur.fetchall():
            out.append({k: _jsonify(v) for k, v in r.items()})
        return out


# --------------------------------------------------------------------------
# PostgREST fallback (no SUPABASE_DB_URL): reads via the service_role key.
# Same contract as query_visits above: same filters, same output fields,
# same (business_date asc, id asc) ordering.
# --------------------------------------------------------------------------

_VISIT_SELECT = ','.join(
    'date:business_date' if f == 'date'
    else 'dateObj:date_obj' if f == 'dateObj'
    else f
    for f in _VISIT_FIELDS) + ',id'


def _rest_get(path: str, params: list[tuple[str, str]]) -> list[dict]:
    base, key = config.SUPABASE_URL, config.SERVICE_ROLE_KEY
    if not base or not key:
        raise RuntimeError('visits query needs SUPABASE_DB_URL or '
                           'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY')
    url = base.rstrip('/') + '/rest/v1/' + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Accept-Encoding': 'gzip',
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            raw = resp.read()
            if resp.headers.get('Content-Encoding') == 'gzip':
                raw = gzip.decompress(raw)
            data = json.loads(raw)
            return data if isinstance(data, list) else []
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        raise RuntimeError(f'PostgREST {path} -> HTTP {e.code}: {body[:500]}') from None


def _in_value(v: str) -> str:
    s = str(v)
    if any(c in s for c in ',.()" \t') or s == '':
        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    return s


def rest_query_visits(filters: dict) -> list[dict]:
    jobs = _rest_get('ccr_import_jobs', [
        ('select', 'id'), ('active', 'eq.true'), ('status', 'eq.COMPLETED'),
        ('order', 'completed_at.desc'), ('limit', '1')])
    if not jobs:
        return []
    import_id = jobs[0]['id']

    base: list[tuple[str, str]] = [('select', _VISIT_SELECT),
                                   ('import_id', 'eq.' + import_id)]
    if filters.get('date_from'):
        base.append(('business_date', 'gte.' + str(filters['date_from'])))
    if filters.get('date_to'):
        base.append(('business_date', 'lte.' + str(filters['date_to'])))

    def arr(name: str, col: str) -> None:
        v = filters.get(name) or []
        if v:
            base.append((col, 'in.(' + ','.join(_in_value(x) for x in v) + ')'))

    arr('branch_locs', 'branch_location')
    arr('zsms', 'zsm')
    arr('asms', 'asm')
    arr('asos', 'aso')
    arr('dse_codes', 'dse_code')
    arr('channels', 'channel')
    on_route = filters.get('on_route') or 'ALL'
    if on_route not in ('ALL', ''):
        base.append(('on_route', 'eq.' + on_route))

    # Keyset pagination on id (break only on an empty page, so a server-side
    # row cap can never truncate silently), then the browser's sort order.
    rows: list[dict] = []
    last_id = 0
    while True:
        page = _rest_get('ccr_raw', base + [('order', 'id.asc'),
                                            ('limit', '50000'),
                                            ('id', 'gt.' + str(last_id))])
        if not page:
            break
        rows.extend(page)
        last_id = page[-1]['id']
    rows.sort(key=lambda r: (r['date'], r['id']))
    for r in rows:
        del r['id']
    return rows

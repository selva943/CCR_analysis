r"""Import an CCR xlsx into Supabase over PostgREST using the service_role key.

Alternative to the COPY path (which needs SUPABASE_DB_URL): use this when you
only have the URL + service_role key. Same job lifecycle as backend/app/main.py:
parse → create job → batch-insert ccr_raw → complete+activate (or fail+cleanup).

Usage:
  set SUPABASE_URL=https://xxxx.supabase.co
  set SUPABASE_SERVICE_ROLE_KEY=eyJ...
  python backend/scripts/import_rest.py "G:\path\file.xlsx" [--dry-run] [--batch 2000]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))

from app import ccr_parse, xlsxio  # noqa: E402
from app.db import COPY_COLS  # noqa: E402  (single source of truth for columns)


def load_env() -> None:
    """Minimal .env loader (backend/.env) — no extra dependency."""
    env_path = ROOT / 'backend' / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in __import__('os').environ:
            __import__('os').environ[k] = v


class Supa:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip('/')
        self.key = key

    def req(self, method: str, path: str, body: object | None = None,
            prefer: str = 'return=representation') -> tuple[int, object]:
        url = f'{self.base}/rest/v1/{path}'
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8') \
            if body is not None else None
        r = urllib.request.Request(url, data=data, method=method, headers={
            'apikey': self.key,
            'Authorization': f'Bearer {self.key}',
            'Content-Type': 'application/json',
            'Prefer': prefer,
        })
        try:
            with urllib.request.urlopen(r, timeout=120) as resp:
                raw = resp.read()
                return resp.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read().decode('utf-8', 'replace')
            raise RuntimeError(f'{method} {path} -> HTTP {e.code}: {raw[:800]}') from None


def _finite(v: object) -> object:
    if isinstance(v, float) and not (v == v and abs(v) != float('inf')):
        return None  # NaN/Infinity → NULL (JSON has no NaN)
    return v


def build_row(v: dict, import_id: str, source_file: str) -> dict:
    """Visit dict → ccr_raw JSON row (same mapping as db.copy_visits)."""
    row: dict = {}
    for f in COPY_COLS:
        if f == 'import_id':
            row[f] = import_id
        elif f == 'source_file':
            row[f] = source_file
        elif f == 'is_valid':
            row[f] = bool(v.get('_is_valid', True))
        elif f == 'dup_key':
            row[f] = v.get('_dup_key')
        elif f == 'business_date':
            row[f] = v['date']  # 'YYYY-MM-DD' → date cast by PostgREST
        else:
            row[f] = _finite(v.get('dateObj' if f == 'date_obj' else f))
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--dry-run', action='store_true', help='parse + build rows, no DB writes')
    ap.add_argument('--batch', type=int, default=2000)
    ap.add_argument('--url', default=None, help='override SUPABASE_URL')
    ap.add_argument('--key', default=None, help='override SUPABASE_SERVICE_ROLE_KEY')
    args = ap.parse_args()

    load_env()
    import os
    base = args.url or os.environ.get('SUPABASE_URL', '').strip()
    key = args.key or os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').strip()
    if not args.dry_run and (not base or not key):
        print('ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY '
              '(env, backend/.env, or --url/--key)', file=sys.stderr)
        return 2

    xlsx_path = Path(args.xlsx)
    raw = xlsx_path.read_bytes()
    file_hash = hashlib.sha256(raw).hexdigest()
    file_name = xlsx_path.name

    t0 = time.time()
    rows_in = xlsxio.sheet_rows(raw)
    t1 = time.time()
    res = ccr_parse.process_sheet(rows_in)
    t2 = time.time()
    if res.get('error'):
        print('PARSE ERROR:', res['error'], file=sys.stderr)
        return 1
    visits = res['visits']
    print(f'parsed: {len(visits)} visits (sheet_rows {t1-t0:.1f}s, process {t2-t1:.1f}s), '
          f'report totalRows={res["report"]["totalRows"]}')

    if args.dry_run:
        built = [build_row(v, '00000000-0000-0000-0000-000000000000', file_name)
                 for v in visits]
        print(f'DRY RUN OK — built {len(built)} rows, keys/row={len(built[0])}')
        print(json.dumps(built[0], ensure_ascii=False)[:400])
        return 0

    supa = Supa(base, key)

    # --- existing completed job with same file hash? reactivate (metadata-only)
    _, existing = supa.req(
        'GET',
        f'ccr_import_jobs?select=*&file_hash=eq.{file_hash}&status=eq.COMPLETED'
        '&order=completed_at.desc&limit=1')
    if existing:
        job = existing[0]
        print(f'reactivating completed job {job["id"]} (same file hash)')
        supa.req('PATCH', 'ccr_import_jobs?active=eq.true', {'active': False},
                 prefer='return=minimal')
        supa.req('PATCH', f'ccr_import_jobs?id=eq.{job["id"]}',
                 {'active': True}, prefer='return=minimal')
        print('DONE (reactivated, no re-upload needed)')
        return 0

    # --- new job
    _, jobs = supa.req('POST', 'ccr_import_jobs', [{
        'file_name': file_name,
        'file_hash': file_hash,
        'status': 'PENDING',
        'imported_by': 'import_rest.py',
    }])
    job = jobs[0]
    job_id = job['id']
    print(f'created job {job_id}')

    try:
        supa.req('PATCH', f'ccr_import_jobs?id=eq.{job_id}',
                 {'status': 'PROCESSING', 'started_at': datetime.now(timezone.utc).isoformat()},
                 prefer='return=minimal')
        supa.req('PATCH', 'ccr_import_jobs?active=eq.true', {'active': False},
                 prefer='return=minimal')

        t3 = time.time()
        n = len(visits)
        for start in range(0, n, args.batch):
            part = [build_row(v, job_id, file_name) for v in visits[start:start + args.batch]]
            supa.req('POST', 'ccr_raw', part, prefer='return=minimal')
            done = min(start + args.batch, n)
            if done % (args.batch * 10) == 0 or done == n:
                print(f'  inserted {done}/{n} ({time.time()-t3:.0f}s)')
        t4 = time.time()

        supa.req('PATCH', f'ccr_import_jobs?id=eq.{job_id}', {
            'status': 'COMPLETED',
            'active': True,
            'report': res['report'],
            'total_rows': res['report']['totalRows'],
            'processed_rows': n,
            'failed_rows': 0,
            'completed_at': datetime.now(timezone.utc).isoformat(),
        }, prefer='return=minimal')
        print(f'DONE — job {job_id} active; insert {t4-t3:.1f}s '
              f'({n} rows in {(n + args.batch - 1) // args.batch} batches)')
        return 0
    except Exception as e:  # noqa: BLE001 — cleanup then re-raise
        print('FAILED:', e, file=sys.stderr)
        try:
            supa.req('DELETE', f'ccr_raw?import_id=eq.{job_id}', prefer='return=minimal')
            supa.req('PATCH', f'ccr_import_jobs?id=eq.{job_id}', {
                'status': 'FAILED',
                'error_message': str(e)[:1000],
                'completed_at': datetime.now(timezone.utc).isoformat(),
            }, prefer='return=minimal')
            print('cleaned up partial rows + marked job FAILED', file=sys.stderr)
        except Exception as e2:  # noqa: BLE001
            print('cleanup also failed:', e2, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

"""CCR FastAPI backend — import pipeline + row-level visit API.

Auth: every data endpoint requires a valid Supabase access token
(`Authorization: Bearer …`). `/api/import` additionally requires the admin
role (or the legacy X-Import-Token when CCR_IMPORT_TOKEN is set). see
backend/app/auth.py.

Endpoints
  GET  /api/health
  POST /api/import          (multipart xlsx) → import job (async-style polling)
  GET  /api/jobs            recent jobs
  GET  /api/jobs/{id}       job status/report
  GET  /api/visits          gzip JSON, browser filter semantics (row-level cache
                            for Spend/Geo/Engine/export in the dashboard)
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import time
from datetime import date
from typing import Annotated

from fastapi import FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import auth, config, ccr_parse, db, xlsxio

app = FastAPI(title='CCR analysis backend', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=['*'],
    allow_headers=['*'],
    expose_headers=['Content-Encoding', 'x-payload-encoding'],
)


@app.get('/api/health')
def health() -> dict:
    try:
        db.get_pool()
        db_ok = True
    except Exception:  # noqa: BLE001 — health check must not raise
        db_ok = False
    rest_ok = bool(config.SUPABASE_URL and config.SERVICE_ROLE_KEY)
    return {'ok': True, 'db': db_ok, 'rest': rest_ok}


def _require_db() -> None:
    if not config.DATABASE_URL:
        raise HTTPException(
            status_code=503,
            detail='SUPABASE_DB_URL is not configured — import via '
                   'python backend/scripts/import_rest.py instead')


# --------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------

@app.post('/api/import')
def import_file(
    request: Request,
    file: Annotated[UploadFile, File()],
    force: Annotated[str | None, Query()] = None,
    imported_by: Annotated[str | None, Header()] = None,
    x_import_token: Annotated[str | None, Header()] = None,
) -> dict:
    # Two allowed paths: a verified admin JWT, or the legacy shared import
    # token (only if CCR_IMPORT_TOKEN is set on the server).
    try:
        auth.require_admin(request)
    except HTTPException as exc:
        if exc.status_code not in (401, 403):
            raise
        if not (config.IMPORT_TOKEN and x_import_token == config.IMPORT_TOKEN):
            raise
        imported_by = imported_by or 'import_token'
    _require_db()
    raw = file.file.read()
    max_bytes = config.MAX_UPLOAD_MB * 1024 * 1024
    if len(raw) > max_bytes:
        raise HTTPException(status_code=413, detail='file too large')
    if not raw:
        raise HTTPException(status_code=400, detail='empty file')

    file_name = file.filename or 'upload.xlsx'
    file_hash = hashlib.sha256(raw).hexdigest()
    force_b = str(force).lower() in ('1', 'true', 'yes') if force else False
    if not force_b:
        existing = db.find_job_by_hash(file_hash)
        if existing:
            if not existing.get('active'):
                existing = db.reactivate_job(existing['id']) or existing
            return {'job': existing, 'idempotent': True}

    job = db.create_job(file_name, file_hash, imported_by)
    job_id = job['id']
    db.mark_processing(job_id)
    t0 = time.time()

    try:
        rows = xlsxio.sheet_rows(raw)
        result = ccr_parse.process_sheet(rows)
    except Exception as exc:  # noqa: BLE001 — surfaced to the job record
        return {'job': db.fail_job(job_id, f'{type(exc).__name__}: {exc}')}

    report = result['report']
    visits = result['visits']
    if result['error']:
        return {'job': db.fail_job(job_id, result['error'], report=report,
                                   total_rows=report.get('totalRows', 0),
                                   failed_rows=report.get('totalRows', 0))}

    try:
        db.copy_visits(job_id, visits, source_file=file_name)
        job = db.complete_job(job_id, report=report,
                              total_rows=report['totalRows'],
                              processed_rows=len(visits),
                              failed_rows=report['totalRows'] - report['validRows'])
    except Exception as exc:  # noqa: BLE001
        return {'job': db.fail_job(job_id, f'{type(exc).__name__}: {exc}', report=report)}

    job['parse_seconds'] = round(time.time() - t0, 2)
    return {'job': job, 'idempotent': False}


@app.get('/api/jobs')
def jobs(request: Request, limit: Annotated[int, Query(ge=1, le=100)] = 20) -> dict:
    auth.require_user(request)
    _require_db()
    return {'jobs': db.list_jobs(limit)}


@app.get('/api/jobs/{job_id}')
def job_status(request: Request, job_id: str) -> dict:
    auth.require_user(request)
    _require_db()
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='job not found')
    return {'job': job}


# --------------------------------------------------------------------------
# Row-level visits (gzip JSON)
# --------------------------------------------------------------------------

class GzipJSONResponse(Response):
    media_type = 'application/json'

    def render(self, content) -> bytes:
        data = json.dumps(content, ensure_ascii=False, separators=(',', ':'),
                          allow_nan=False).encode('utf-8')
        buf = io.BytesIO()
        with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=6) as gz:
            gz.write(data)
        return buf.getvalue()


@app.get('/api/visits')
def visits(
    request: Request,
    date_from: Annotated[date | None, Query(alias='dateFrom')] = None,
    date_to: Annotated[date | None, Query(alias='dateTo')] = None,
    branch_loc: Annotated[list[str] | None, Query(alias='branch_loc')] = None,
    zsms: Annotated[list[str] | None, Query()] = None,
    asms: Annotated[list[str] | None, Query()] = None,
    asos: Annotated[list[str] | None, Query()] = None,
    dse_codes: Annotated[list[str] | None, Query(alias='dse_code')] = None,
    channels: Annotated[list[str] | None, Query()] = None,
    on_route: Annotated[str, Query(alias='onRoute')] = 'ALL',
) -> Response:
    # Public read — the dashboard now uses a local employee login with no
    # Supabase JWT, and the underlying data is anon-readable on Supabase too
    # (migration 0006). Writes (/api/import) stay admin/token gated.
    rows = db.query_visits({
        'date_from': date_from, 'date_to': date_to,
        'branch_locs': branch_loc or [], 'zsms': zsms or [],
        'asms': asms or [], 'asos': asos or [],
        'dse_codes': dse_codes or [], 'channels': channels or [],
        'on_route': on_route,
    })
    # Content-Encoding lets fetch() decompress transparently; x-payload-encoding
    # records that the payload itself is gzip for debugging/other clients.
    return GzipJSONResponse(rows, headers={
        'Content-Encoding': 'gzip', 'x-payload-encoding': 'gzip'})

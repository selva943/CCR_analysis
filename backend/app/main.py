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

import contextlib
import gzip
import hashlib
import io
import json
import os
import tempfile
import threading
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


class SheetError(Exception):
    """The workbook parsed into a failure report (e.g. missing columns).

    Raised inside the COPY transaction so a partial write rolls back, while
    carrying the report through to the job record.
    """

    def __init__(self, error: str, report: dict) -> None:
        super().__init__(error)
        self.error = error
        self.report = report


# --------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------

def _run_import(tmp_path: str, job_id: str, file_name: str) -> None:
    """Parse + COPY for one import on a worker thread.

    A real workbook takes minutes to parse and load, but Render cuts HTTP
    requests off long before that — so POST /api/import only spools the file
    to disk, starts this worker and returns the PROCESSING job immediately;
    the dashboard polls GET /api/jobs/{id}. The worker owns the temp file and
    unlinks it when it is done.
    """
    t0 = time.time()
    try:
        try:
            with contextlib.closing(xlsxio.iter_rows(tmp_path)) as rows, \
                    db.visit_writer(job_id, file_name) as write:
                result = ccr_parse.process_sheet(rows, sink=write)
                if result['error']:
                    raise SheetError(result['error'], result['report'])
        except SheetError as exc:
            db.fail_job(job_id, exc.error, report=exc.report,
                        total_rows=exc.report.get('totalRows', 0),
                        failed_rows=exc.report.get('totalRows', 0))
            return
        except Exception as exc:  # noqa: BLE001 — surfaced to the job record
            db.fail_job(job_id, f'{type(exc).__name__}: {exc}')
            return

        report = result['report']
        db.complete_job(job_id, report=report,
                        total_rows=report['totalRows'],
                        processed_rows=result['count'],
                        failed_rows=report['totalRows'] - report['validRows'])
        print(f'[import] {job_id} completed in {round(time.time() - t0, 2)}s '
              f'({result["count"]} visits)', flush=True)
    except Exception as exc:  # noqa: BLE001 — last-resort guard (never lose the job)
        with contextlib.suppress(Exception):
            db.fail_job(job_id, f'{type(exc).__name__}: {exc}')
        print(f'[import] {job_id} crashed: {type(exc).__name__}: {exc}',
              flush=True)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)


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
    max_bytes = config.MAX_UPLOAD_MB * 1024 * 1024

    # Spool the upload to disk in 1MB chunks while hashing it — the workbook is
    # never held in memory (a 23MB file is 170k+ rows once expanded, and the
    # free Render instance only has 512MB).
    fd, tmp_path = tempfile.mkstemp(prefix='ccr-upload-', suffix='.xlsx')
    digest = hashlib.sha256()
    size = 0
    handed_off = False
    try:
        with os.fdopen(fd, 'wb') as tmp:
            while True:
                chunk = file.file.read(1 << 20)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(status_code=413, detail='file too large')
                digest.update(chunk)
                tmp.write(chunk)
        if not size:
            raise HTTPException(status_code=400, detail='empty file')

        file_name = file.filename or 'upload.xlsx'
        file_hash = digest.hexdigest()
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

        # Rows stream off the workbook and visits stream straight into COPY —
        # only one chunk of visits is ever in flight (see db.visit_writer) — but
        # all of it runs on a worker thread, because Render would otherwise kill
        # the request long before the import finishes.
        handed_off = True
        threading.Thread(target=_run_import, args=(tmp_path, job_id, file_name),
                         name=f'ccr-import-{job_id[:8]}', daemon=True).start()
        return {'job': db.get_job(job_id) or job, 'idempotent': False}
    finally:
        if not handed_off:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)


@app.get('/api/jobs')
def jobs(limit: Annotated[int, Query(ge=1, le=100)] = 20) -> dict:
    # Public read — the dashboard uses a local employee login (no Supabase
    # JWT) and polls these to follow an in-flight import. Writes stay gated.
    _require_db()
    return {'jobs': db.list_jobs(limit)}


@app.get('/api/jobs/{job_id}')
def job_status(job_id: str) -> dict:
    # Public read — see /api/jobs above; the import POST returns immediately
    # with a PROCESSING job and the client polls this until COMPLETED/FAILED.
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

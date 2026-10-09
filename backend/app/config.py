"""Environment configuration for the CCR FastAPI backend."""
from __future__ import annotations

import os
from pathlib import Path

# ASCII quote characters used to strip surrounding quotes from .env values.
_QUOTES = chr(34) + chr(39)


def _load_dotenv() -> None:
    """Minimal backend/.env loader (no extra dependency). Existing env wins."""
    env_path = Path(__file__).resolve().parents[1] / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k, v = k.strip().strip(_QUOTES), v.strip().strip(_QUOTES)
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()


def _get(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None:
        return default
    v = v.strip()
    return v if v else default


# Supabase Postgres connection string (Dashboard -> Connect -> Session pooler or
# direct). Optional: without it, /api/visits falls back to PostgREST and
# imports must go through backend/scripts/import_rest.py.
DATABASE_URL = _get('SUPABASE_DB_URL') or _get('DATABASE_URL')

# Supabase URL + service_role key (server-side only): used for /api/visits when
# DATABASE_URL is absent (reads go through PostgREST) and by scripts/import_rest.py.
SUPABASE_URL = _get('SUPABASE_URL')
SERVICE_ROLE_KEY = _get('SUPABASE_SERVICE_ROLE_KEY')

# JWT signing secret (Dashboard -> Settings -> API -> JWT Secret). Required so
# the backend can verify the access tokens that the browser sends.
SUPABASE_JWT_SECRET = _get('SUPABASE_JWT_SECRET')

# Optional CORS restriction; defaults to open (static dashboard can be anywhere).
ALLOWED_ORIGINS = [o.strip() for o in (_get('ALLOWED_ORIGINS', '*') or '*').split(',')]

# Optional shared secret for POST /api/import (browser sends X-Import-Token).
IMPORT_TOKEN = _get('CCR_IMPORT_TOKEN')

# Upload cap (MB) for the xlsx.
MAX_UPLOAD_MB = int(_get('MAX_UPLOAD_MB', '200') or '200')

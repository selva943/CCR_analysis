"""Supabase JWT authentication + role checks for the CCR backend.

The browser signs in via Supabase Auth (GoTrue) and sends
`Authorization: Bearer <access_token>`. We verify that token, confirm it is an
`authenticated` user token, and then resolve the app role from
`public.user_roles`:

    admin  -> may POST /api/import (process the data)
    viewer -> may read dashboard data only

Verification supports both of Supabase's signing schemes:

  * asymmetric (ES256/RS256) — the default for new projects. The public key is
    fetched from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` (matched by the
    token's `kid` header). This needs only SUPABASE_URL.
  * symmetric (HS256) — legacy projects. Needs SUPABASE_JWT_SECRET.

Role lookups run server-side (psycopg when SUPABASE_DB_URL is set, otherwise
through PostgREST with the service_role key), so a viewer can never lie by
crafting their own token.
"""
from __future__ import annotations

import uuid

import jwt
from jwt import PyJWKClient

from fastapi import HTTPException, Request

from . import config, db

_USER_ROLE = 'authenticated'
_AUDIENCE = 'authenticated'

_jwks_client: PyJWKClient | None = None


def _issuer() -> str | None:
    base = (config.SUPABASE_URL or '').rstrip('/')
    return f'{base}/auth/v1' if base else None


def _jwks() -> PyJWKClient | None:
    global _jwks_client
    base = (config.SUPABASE_URL or '').rstrip('/')
    if not base:
        return None
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            base + '/auth/v1/.well-known/jwks.json', cache_keys=True)
    return _jwks_client


def verify_token(token: str) -> dict:
    """Decode + verify a Supabase access token; returns its claims."""
    if not token:
        raise HTTPException(status_code=401, detail='missing bearer token')
    try:
        alg = jwt.get_unverified_header(token).get('alg', '')
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f'invalid access token: {exc}') from None

    try:
        if alg == 'HS256':
            secret = config.SUPABASE_JWT_SECRET
            if not secret:
                raise HTTPException(
                    status_code=503,
                    detail='SUPABASE_JWT_SECRET is not configured — set it in '
                           'backend/.env (Dashboard -> Settings -> API -> JWT Secret)')
            claims = jwt.decode(token, secret, algorithms=['HS256'],
                                audience=_AUDIENCE)
        else:
            client = _jwks()
            if client is None:
                raise HTTPException(
                    status_code=503,
                    detail='SUPABASE_URL is not configured — cannot verify the '
                           'token via JWKS')
            key = client.get_signing_key_from_jwt(token).key
            kwargs = {'algorithms': [alg], 'audience': _AUDIENCE}
            iss = _issuer()
            if iss:
                kwargs['issuer'] = iss
            claims = jwt.decode(token, key, **kwargs)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail='access token expired') from None
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f'invalid access token: {exc}') from None

    if claims.get('role') != _USER_ROLE:
        raise HTTPException(status_code=401, detail='token is not an authenticated user token')
    return claims


def bearer_token(request: Request) -> str:
    header = request.headers.get('authorization', '')
    if not header.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='missing bearer token')
    return header.split(' ', 1)[1].strip()


def require_user(request: Request) -> dict:
    """Any valid authenticated user (admin or viewer) may pass."""
    return verify_token(bearer_token(request))


def _sub_uuid(sub: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError, AttributeError):
        return None


def user_role(user_id: str) -> str | None:
    """Resolve 'admin' / 'viewer' for a user id (None = unknown/no row)."""
    uid = _sub_uuid(user_id)
    if uid is None:
        return None
    if config.DATABASE_URL:
        return db.get_user_role(uid)
    return db.rest_get_user_role(str(uid))


def require_admin(request: Request) -> dict:
    """Import-style endpoint: the caller must have the admin role."""
    claims = verify_token(bearer_token(request))
    role = user_role(claims['sub'])
    if role != 'admin':
        raise HTTPException(status_code=403, detail='admin role required to process data')
    return claims
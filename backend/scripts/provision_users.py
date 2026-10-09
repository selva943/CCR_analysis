r"""Provision the CCR dashboard users: 1 admin + 7 viewers.

Creates (or updates) the users in Supabase Auth (email + password), stamps
their role into app_metadata, and upserts public.user_roles so the app and the
backend can resolve admin vs viewer.

Requirements:
  * SUPABASE_URL            = https://<project>.supabase.co
  * SUPABASE_SERVICE_ROLE_KEY = a REAL service_role key (owns users + writes)

Usage (run from the repo root):
  set SUPABASE_URL=https://xxxx.supabase.co
  set SUPABASE_SERVICE_ROLE_KEY=eyJ...
  python backend/scripts/provision_users.py
  python backend/scripts/provision_users.py --password "P@ssw0rd!" \
      --admin admin@example.com --viewers 7 --list-only

Output:
  * Prints the credentials table (save it / hand the viewer accounts out)
  * Writes backend/.users.json with the same info (chmod 600 equivalent
    note: on Windows set user-only ACLs if you care).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))


def load_env() -> None:
    env_path = ROOT / 'backend' / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


class Supa:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip('/')
        self.key = key

    def req(self, method: str, path: str, body=None, auth: str | None = None,
            extra: dict | None = None) -> tuple[int, object]:
        headers = {
            'apikey': self.key,
            'Authorization': 'Bearer ' + (auth or self.key),
            'Content-Type': 'application/json',
        }
        if extra:
            headers.update(extra)
        url = f'{self.base}/{path}'
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8') \
            if body is not None else None
        r = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                raw = resp.read()
                return resp.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raw = e.read().decode('utf-8', 'replace')
            raise RuntimeError(f'{method} {path} -> HTTP {e.code}: {raw[:600]}') from None


def find_user(supa, email):
    """Find a user by email (paginated admin list)."""
    page = 1
    while True:
        status, payload = supa.req(
            'GET', f'auth/v1/admin/users?page={page}&per_page=200')
        if status != 200 or not payload:
            return None
        users = payload.get('users') if isinstance(payload, dict) else payload
        if not users:
            return None
        for u in users:
            if (u.get('email') or '').lower() == email.lower():
                return u
        if len(users) < 200:
            return None
        page += 1


def create_user(supa, email, password, role):
    status, user = supa.req('POST', 'auth/v1/admin/users', {
        'email': email,
        'password': password,
        'email_confirm': True,
        'app_metadata': {'ccr_role': role},
    })
    if status not in (200, 201):
        raise RuntimeError(f'create user {email} failed: HTTP {status} {user}')
    return user


def update_user(supa, user_id, role, password=None):
    body = {'app_metadata': {'ccr_role': role}}
    if password:
        body['password'] = password
    supa.req('PUT', f'auth/v1/admin/users/{user_id}', body)


def gen_password(length=16):
    alphabet = string.ascii_letters + string.digits + '!@#$%^&*-_'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def upsert_role(supa, user_id, email, role):
    status, rows = supa.req(
        'GET', f'rest/v1/user_roles?user_id=eq.{user_id}&select=user_id,role')
    if status == 200 and rows:
        supa.req('PATCH', f'rest/v1/user_roles?user_id=eq.{user_id}',
                 {'role': role, 'email': email})
    else:
        supa.req('POST', 'rest/v1/user_roles',
                 {'user_id': user_id, 'email': email, 'role': role})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--admin', default='admin@example.com')
    ap.add_argument('--viewers', type=int, default=7)
    ap.add_argument('--prefix', default='viewer')
    ap.add_argument('--domain', default='example.com')
    ap.add_argument('--password', default='CCR-Admin@123')
    ap.add_argument('--unique-passwords', action='store_true',
                    help='give every account its own random password')
    ap.add_argument('--list-only', action='store_true',
                    help='print the user/role plan and exit (no API calls)')
    ap.add_argument('--url', default=None)
    ap.add_argument('--key', default=None)
    args = ap.parse_args()

    load_env()
    base = (args.url or os.environ.get('SUPABASE_URL', '')).strip().rstrip('/')
    key = args.key or os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').strip()

    def pw(_email):
        return gen_password() if args.unique_passwords else args.password

    viewer_emails = [f'{args.prefix}{i}@{args.domain}' for i in range(1, args.viewers + 1)]
    plan = [('admin', args.admin, pw(args.admin))] + [
        ('viewer', email, pw(email)) for email in viewer_emails]

    out = {'admin': {'email': args.admin, 'password': plan[0][2]},
           'viewers': [{'email': e, 'password': p}
                       for (_, e, p) in plan if _ != 'admin']}

    if args.list_only:
        print(json.dumps(out, indent=2))
        return 0

    if not base or not key:
        print('ERROR: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY '
              '(env or backend/.env, or --url/--key) — a REAL service_role key '
              'is required to create users.', file=sys.stderr)
        return 2

    supa = Supa(base, key)
    results = []
    for role, email, password in plan:
        user = find_user(supa, email)
        if user:
            uid = user['id']
            update_user(supa, uid, role, password)
            print(f'updated  {role:6s} {email}  (id {uid[:8]}…)')
        else:
            user = create_user(supa, email, password, role)
            uid = user['id']
            print(f'created  {role:6s} {email}  (id {uid[:8]}…)')
        upsert_role(supa, uid, email, role)
        results.append({'email': email, 'role': role, 'password': password})

    # sanity: make sure exactly one admin exists
    admins = [r for r in results if r['role'] == 'admin']
    if len(admins) != 1:
        print('WARNING: expected exactly 1 admin, got', len(admins), file=sys.stderr)

    summary = {
        'project': base,
        'admin': {'email': args.admin, 'password': plan[0][2]},
        'viewers': [
            {'email': r['email'], 'password': r['password']}
            for r in results if r['role'] == 'viewer'],
    }
    out_path = ROOT / 'backend' / '.users.json'
    out_path.write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print()
    print(f'Wrote {out_path}')
    print(f'Admin:  {summary["admin"]["email"]}  /  {summary["admin"]["password"]}')
    for v in summary['viewers']:
        print(f'Viewer: {v["email"]}  /  {v["password"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
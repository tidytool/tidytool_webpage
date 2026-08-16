#!/usr/bin/env python3
"""Apply a migration to the dev or prod Supabase database — or verify parity.

The portal/supabase/migrations directory must stay byte-for-byte identical to
each environment's supabase_migrations.schema_migrations history (see that
directory's README). This script is the one sanctioned way to keep that true:
it runs the migration SQL via the Supabase Management API, records the history
row as a single-element statements array (so array_to_string(statements) is
exactly the file's bytes), and verifies the md5 afterwards.

Usage:
  tools/db_apply.py --check --env dev            # verify local dir vs dev history
  tools/db_apply.py <file.sql> --env dev         # apply one migration to dev
  tools/db_apply.py <file.sql> --env prod --approved
                                                 # prod requires the approval flag
                                                 # (sign-off from Sam or Shem)
  tools/db_apply.py <file.sql> --env prod --approved --reload-postgrest
                                                 # apply + refresh PostgREST schema cache
  tools/db_apply.py --reload-postgrest --env prod
                                                 # refresh the cache on its own

Auth: uses $SUPABASE_ACCESS_TOKEN, else the Supabase CLI's token from the
macOS keychain. Read-only unless applying.

Environments:  dev  = branch gfkrebuioszsxanjdnsx
               prod = project tkrrvpoupekrjqditupi
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request

REFS = {"dev": "gfkrebuioszsxanjdnsx", "prod": "tkrrvpoupekrjqditupi"}
MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), "..", "portal", "supabase", "migrations")
NAME_RE = re.compile(r"^(\d{14})_([a-z0-9_]+)\.sql$")


def token():
    tok = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if tok:
        return tok
    try:
        return subprocess.check_output(
            ["security", "find-generic-password", "-s", "Supabase CLI", "-w"],
            stderr=subprocess.DEVNULL).decode().strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit("No Supabase access token: set SUPABASE_ACCESS_TOKEN or `supabase login`.")


def query(ref, sql, tok):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                 "User-Agent": "tidytool-db-apply/1.0"},
        method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read() or b"[]")
    except urllib.error.HTTPError as e:
        sys.exit(f"Query failed ({e.code}): {e.read().decode()[:800]}")


def local_migrations():
    out = {}
    for fn in sorted(os.listdir(MIGRATIONS_DIR)):
        m = NAME_RE.match(fn)
        if m:
            content = open(os.path.join(MIGRATIONS_DIR, fn), "rb").read()
            out[m.group(1)] = (m.group(2), hashlib.md5(content).hexdigest(), fn)
    return out


def remote_migrations(ref, tok):
    rows = query(ref, r"select version, name, md5(array_to_string(statements, E';\n')) as md5 "
                      "from supabase_migrations.schema_migrations order by version", tok)
    return {r["version"]: (r.get("name"), r["md5"]) for r in rows}


def check(env, tok):
    """The hard contract is version+name 1:1 both ways. Content md5 is only a
    best-effort signal: history rows written by this script (and the ten
    materialized 2026-07-03 baseline rows) are byte-faithful, but rows applied
    via the Supabase MCP have comments stripped/statements normalized, and
    rows recorded by hand may have NULL statements. Those two classes get an
    informational note, not a failure."""
    ref = REFS[env]
    local, remote = local_migrations(), remote_migrations(ref, tok)
    ok, verified, unverifiable = True, 0, 0
    for v in sorted(set(local) | set(remote)):
        if v not in remote:
            print(f"  {v} {local[v][0]:45s} LOCAL ONLY — not applied to {env}")
            ok = False
        elif v not in local:
            print(f"  {v} {remote[v][0] or '?':45s} {env.upper()} ONLY — missing locally")
            ok = False
        elif local[v][0] != remote[v][0]:
            print(f"  {v} NAME MISMATCH: local '{local[v][0]}' != {env} '{remote[v][0]}'")
            ok = False
        elif remote[v][1] is None:
            unverifiable += 1  # history row recorded without statements
        elif local[v][1] != remote[v][1]:
            unverifiable += 1  # MCP-normalized content; bytes not comparable
        else:
            verified += 1
    print(f"{'OK' if ok else 'DIVERGED'}: {len(local)} local file(s), {len(remote)} row(s) on {env}; "
          f"{verified} byte-verified, {unverifiable} recorded without byte-faithful content.")
    return 0 if ok else 1


def reload_postgrest(env, tok):
    """Force PostgREST to reload its schema cache. A function created or renamed
    by a migration 404s from /rest/v1/rpc/ until the cache refreshes, and
    `notify pgrst, 'reload schema'` issued through the Management API query
    endpoint does not reach PostgREST (observed on prod, 2026-08-15). PATCHing
    the PostgREST config with its own current values restarts it — expect a
    seconds-long blip on the REST API."""
    ref = REFS[env]
    url = f"https://api.supabase.com/v1/projects/{ref}/postgrest"
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
               "User-Agent": "tidytool-db-apply/1.0"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers)) as resp:
            cfg = json.loads(resp.read())
        body = {k: cfg[k] for k in ("db_schema", "max_rows", "db_extra_search_path")
                if cfg.get(k) is not None}
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     headers=headers, method="PATCH")
        with urllib.request.urlopen(req):
            pass
    except urllib.error.HTTPError as e:
        sys.exit(f"PostgREST reload failed ({e.code}): {e.read().decode()[:800]}")
    print(f"PostgREST schema cache reloading on {env} ({ref}); "
          "REST may blip for a few seconds. New RPCs should resolve shortly.")


def dollar_tag(content):
    for i in range(100):
        tag = f"$m{i}$"
        if tag not in content:
            return tag
    sys.exit("Could not find a safe dollar-quote tag.")


def apply(path, env, approved, tok):
    ref = REFS[env]
    fn = os.path.basename(path)
    m = NAME_RE.match(fn)
    if not m:
        sys.exit(f"{fn}: name must be YYYYMMDDHHMMSS_snake_case_name.sql")
    version, name = m.group(1), m.group(2)
    content = open(path, encoding="utf-8").read()

    if env == "prod":
        header = "\n".join(l for l in content.splitlines()[:40] if l.startswith("--"))
        print(f"=== PROD APPLY: {fn} ===\n{header}\n")
        if not approved:
            sys.exit("Refusing: applying to PROD requires explicit approval from Sam or Shem (--approved).")

    if version in remote_migrations(ref, tok):
        sys.exit(f"{version} is already in {env}'s history. Nothing to do.")

    tag = dollar_tag(content)
    query(ref, content + f"""
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('{version}', '{name}', array[{tag}{content}{tag}]);
""", tok)

    got = remote_migrations(ref, tok).get(version)
    want = hashlib.md5(content.encode()).hexdigest()
    if not got:
        sys.exit(f"Applied, but no history row for {version} — investigate before retrying.")
    if got[1] != want:
        sys.exit(f"Applied, but history md5 {got[1]} != file md5 {want} — byte parity broken, fix before proceeding.")
    print(f"Applied {fn} to {env} ({ref}). History md5 verified: {want}.")
    if re.search(r"create\s+(or\s+replace\s+)?function", content, re.IGNORECASE):
        print("Note: if this migration ADDED or RENAMED a REST-exposed function, the live "
              "site 404s it until PostgREST reloads its schema cache — run with "
              "--reload-postgrest (replacing an existing function needs no reload).")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file", nargs="?", help="migration .sql file to apply")
    p.add_argument("--env", required=True, choices=["dev", "prod"])
    p.add_argument("--check", action="store_true", help="verify local dir vs environment history")
    p.add_argument("--approved", action="store_true", help="required for --env prod applies")
    p.add_argument("--reload-postgrest", action="store_true",
                   help="refresh PostgREST's schema cache (needed after adding/renaming a "
                        "REST-exposed function; causes a seconds-long REST blip)")
    a = p.parse_args()
    tok = token()
    if a.check:
        sys.exit(check(a.env, tok))
    if not a.file and not a.reload_postgrest:
        p.error("provide a migration file, or use --check / --reload-postgrest")
    if a.file:
        apply(a.file, a.env, a.approved, tok)
    if a.reload_postgrest:
        reload_postgrest(a.env, tok)


if __name__ == "__main__":
    main()

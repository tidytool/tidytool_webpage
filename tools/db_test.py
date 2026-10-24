#!/usr/bin/env python3
"""Run a SQL test file against the DEV Supabase database and print its result rows.

Test files live in portal/supabase/tests/. Each one is self-contained: it opens a
transaction, builds its own fixtures, asserts, returns one row per assertion and
ROLLS BACK, so nothing is left behind on dev. This runner refuses any env but dev
on purpose: tests simulate roles with `set local role` + `request.jwt.claims` and
write fixtures, which never belongs on prod.

Usage:
  python3 tools/db_test.py portal/supabase/tests/<file>.sql          # pretty table, exit 1 on any FAIL
  python3 tools/db_test.py portal/supabase/tests/<file>.sql --json   # raw rows

Auth: same as tools/db_apply.py ($SUPABASE_ACCESS_TOKEN or the Supabase CLI keychain token).
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True  # importing db_apply must not leave tools/__pycache__ behind
sys.path.insert(0, os.path.dirname(__file__))
import db_apply  # noqa: E402  (shared token + Management API query helper)

DEV_REF = db_apply.REFS["dev"]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("file", help="SQL test file (must end in ROLLBACK and return result rows)")
    p.add_argument("--json", action="store_true", help="print raw JSON rows")
    a = p.parse_args()

    sql = open(a.file, encoding="utf-8").read()
    if "rollback" not in sql.lower():
        sys.exit(f"{a.file}: refusing to run a test file that never rolls back.")

    rows = db_apply.query(DEV_REF, sql, db_apply.token())
    if a.json:
        print(json.dumps(rows, indent=1, default=str))
    failed = 0
    for r in rows:
        ok = r.get("ok")
        failed += 0 if ok else 1
        if not a.json:
            print(f"{'PASS' if ok else 'FAIL'}  {r.get('n', ''):>3}  {r.get('test', '')}"
                  + ("" if ok else f"  -- {r.get('detail', '')}"))
    print(f"{len(rows) - failed}/{len(rows)} passed on dev ({DEV_REF}).")
    sys.exit(1 if failed or not rows else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""PreToolUse guard for Bash in tidytool_webpage.

Denies (exit 2, reason on stderr -> fed back to Claude):
  - any git push that targets main/master, force-pushes, or pushes while on main
  - prod database writes: db_apply.py --env prod, supabase db push/reset --linked,
    psql/execute against the prod project ref
  - deleting the migrations directory or editing applied migration files in place

Everything else passes (exit 0). PreToolUse runs before permission checks, so a deny
holds even under --permission-mode dontAsk / bypassPermissions.

Reads the hook payload from stdin: {"tool_name": "Bash", "tool_input": {"command": "..."}, ...}
"""
import json
import os
import re
import subprocess
import sys

PROD_REF = "tkrrvpoupekrjqditupi"


def current_branch(cwd: str) -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd, capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip()
    except Exception:
        return ""


def deny(reason: str) -> None:
    sys.stderr.write(f"BLOCKED by .claude/hooks/guard_bash.py: {reason}\n")
    sys.exit(2)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # malformed payload: don't block unrelated tools

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    cmd = (payload.get("tool_input") or {}).get("command", "") or ""
    flat = " ".join(cmd.split())
    cwd = payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()

    # --- git push guards -------------------------------------------------------------
    if re.search(r"\bgit\s+(?:-C\s+\S+\s+)?push\b", flat):
        if re.search(r"\s(?:--force|-f|--force-with-lease)\b", flat):
            deny("force-push is not allowed from an agent session; ask Sam.")
        if re.search(r"\b(?:main|master)\b", flat):
            deny("pushing to main/master is not allowed; push an agent/* branch and open a PR.")
        if re.search(r"\bpush\s+(?:\S+\s+)?HEAD:(?:main|master)\b", flat):
            deny("pushing HEAD to main/master is not allowed.")
        # Bare `git push` / `git push origin` pushes the current branch — refuse that on main.
        m = re.search(r"\bpush\b(.*)$", flat)
        args = [a for a in (m.group(1).split() if m else []) if not a.startswith("-") and not a.startswith("&") and a not in ("|", "||", "&&", ";")]
        if len(args) <= 1 and current_branch(cwd) in ("main", "master"):
            deny("you are on main; create an agent/<todoist-id>-<slug> branch first.")

    # --- prod database guards -------------------------------------------------------
    if "db_apply" in flat and re.search(r"--env\s+prod\b", flat):
        deny("prod migrations are applied by Sam only. Apply to dev, then create a needs-sam Todoist task with the exact command.")
    if re.search(r"\bsupabase\s+db\s+(?:push|reset|remote)\b", flat):
        deny("supabase db push/reset is not an allowed path; migrations go through tools/db_apply.py (dev) and Sam (prod).")
    if PROD_REF in flat and re.search(r"\b(?:psql|execute_sql|pg_dump|DROP|DELETE|TRUNCATE|UPDATE)\b", flat, re.I):
        deny("that looks like a write against the PROD project ref; agents only touch dev.")

    # --- migration-history integrity ---------------------------------------------------
    if re.search(r"\brm\b.*supabase/migrations", flat) or re.search(r"\bgit\s+rm\b.*supabase/migrations", flat):
        deny("never delete migration files; the directory mirrors the history table byte-for-byte.")
    if re.search(r"\bsupabase\s+db\s+pull\b", flat):
        deny("`supabase db pull` rewrites migrations; the repo is the source of truth, not the DB.")

    sys.exit(0)


if __name__ == "__main__":
    main()

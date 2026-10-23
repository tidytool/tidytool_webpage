#!/usr/bin/env python3
"""PreToolUse guard for the read-only agents (reviewer, systems-engineer-lens, verifier).

Wired from each agent's frontmatter `hooks:`; runs in addition to guard_bash.py.

Denies (exit 2, reason on stderr -> fed back to Claude):
  - git commit / checkout / reset / stash / clean / rebase (working-tree or history changes)
  - any tools/db_apply.py invocation, including --check (read-only agents don't touch the DB history)

Everything else passes (exit 0).

Reads the hook payload from stdin: {"tool_name": "Bash", "tool_input": {"command": "..."}, ...}
"""
import json
import re
import sys

# `git`, then any global options (-C <path>, -c <k=v>, --flag[=value]), then the subcommand.
GIT_MUTATING = re.compile(
    r"\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(commit|checkout|reset|stash|clean|rebase)\b"
)


def deny(reason: str) -> None:
    sys.stderr.write(f"BLOCKED by .claude/hooks/guard_readonly.py: {reason}\n")
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

    m = GIT_MUTATING.search(flat)
    if m:
        deny(f"`git {m.group(1)}` is not allowed for a read-only agent; use git diff/log/show instead.")
    if "db_apply" in flat:
        deny("db_apply is not allowed for a read-only agent; the implementer applies migrations to dev.")

    sys.exit(0)


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# Stop / SubagentStop gate for tidytool_webpage.
#
# If the session changed anything under portal/, it may not finish until typecheck and the
# unit tests are green. Exit 2 blocks the stop and hands the failure output back to Claude;
# exit 0 lets it finish. Honors stop_hook_active so a blocked stop can't loop forever.
#
# Payload (stdin): {"stop_hook_active": bool, "cwd": "...", ...}
set -u

payload="$(cat)"
if printf '%s' "$payload" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("stop_hook_active") else 1)' 2>/dev/null; then
  exit 0   # we already blocked once this turn; don't loop
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 0

# Only gate when the working tree (vs. main) touches the app.
changed="$( { git diff --name-only main...HEAD 2>/dev/null; git diff --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u )"
if ! printf '%s\n' "$changed" | grep -q '^portal/'; then
  exit 0
fi
# verification.md alone (evidence file) doesn't need a rebuild.
if [ "$(printf '%s\n' "$changed" | grep '^portal/' | grep -vc 'verification.md')" = "0" ]; then
  exit 0
fi

cd portal || exit 0
if [ ! -d node_modules ]; then
  echo "portal/node_modules missing — run \`npm ci\` in portal/ before finishing." >&2
  exit 2
fi

log="$(mktemp)"
fail=0
for step in "npm run typecheck" "npm run test:pricing" "npm run test:labels"; do
  if ! bash -c "$step" >"$log" 2>&1; then
    fail=1
    {
      echo "STOP GATE FAILED: \`$step\` is red. Fix it before finishing. Last 40 lines:"
      tail -n 40 "$log"
    } >&2
    break
  fi
done
rm -f "$log"

if [ "$fail" = "1" ]; then
  exit 2
fi
exit 0

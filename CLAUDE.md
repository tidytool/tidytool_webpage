# CLAUDE.md — tidytool_webpage

Read fully before changing anything. Context for agents, not enforcement; the enforcement is in
`.claude/settings.json` hooks and in the PR gate (nothing merges without Sam).

## What this repo is

Two deployables, two rule sets, one Supabase backend (`tkrrvpoupekrjqditupi`, prod; `gfkrebuioszsxanjdnsx`, dev):

- `docs/` — public marketing site + link-based public pages (`/q/`, `/approve/`). Plain HTML/CSS/JS,
  **no build step, no framework**. GitHub Pages serves only this folder. Its job is converting a
  visitor into a quote request; never slow that path down.
- `portal/` — the customer + admin hub (`app.thetidytool.com`): Next.js 15 App Router, React 19,
  `@supabase/ssr`, server components with a few client islands, minimal deps. Deployed by Vercel
  from `main` (preview deploys per branch). Quoting, order status, approvals, labels, admin CRM
  and pipeline live here.
- `portal/supabase/migrations/` — **the only migration directory in the whole product.** This repo
  owns the schema; tidyCAM and tidyCAD consume it and never migrate (ARCHITECTURE.md decision 1).
- `planning/` (specs, runbooks, contracts), `prompts/`, `tools/` — internal. Never move into `docs/`.

The repo is public on GitHub. Never commit `portal/.env*` or any key.

## Commands (run from `portal/`)

```
npm ci                         # first time on a machine / in a worktree
npm run typecheck              # tsc --noEmit — must be clean before any PR
npm run test:pricing           # pricing engine + QuickBooks projection (node --test via tsx)
npm run test:labels            # labels + order-title
npm run build                  # next build — run before a PR that touches routing or server code
npm run dev                    # local dev server against the env in portal/.env.local
```

Migrations (from the repo root; needs a Supabase personal access token, `supabase login`):

```
python3 tools/db_apply.py --check --env dev          # local dir vs dev history, byte-exact
python3 tools/db_apply.py <file.sql> --env dev       # apply to dev — agents may do this
python3 tools/db_apply.py <file.sql> --env prod --approved   # HUMAN ONLY — hook-blocked for agents
```

## Rules that are not negotiable

1. **Schema:** decided in `planning/contracts/` (Systems Engineer lens), implemented only here, dev
   first via `db_apply.py`, prod applied by Sam. Migration files are byte-exact copies of what the
   history table stores — no added headers, no trailing newline, never `supabase db pull`.
   Expand → backfill → dual-read → cutover → contract; never a breaking rename in place.
2. **Status writes** go through the RPCs (`set_drawer_stage`, `set_drawer_state`, `set_order_*`);
   never raw-update `stage`, `state`, `computed_status`, or `status_event`. `order.drawer_count` /
   `drawer_ids` mean *design rows*, never physical copies.
3. **Pricing** is config-versioned (`pricing_config` rows); engine and config ship together.
   Tier rates, the $40/copy floor and the $250 order minimum are decisions, not tunables.
4. **High-risk = human gate:** quote form / conversion path, prod migrations, RLS, auth, secrets,
   DNS, deleting data, anything touching customer money. Unclear blast radius → treat as high-risk.
   Everything else (copy, styling, additive code, docs) ships through the normal PR flow.
5. **No new dependencies** in `portal/` without sign-off; none at all in `docs/`.
6. **PR-only.** Agents never push to `main`. Every PR carries the Done-when checklist and
   `verification.md` evidence (see `.claude/skills/open-pr-with-evidence`).

## Gotchas that have cost real time

- A Supabase branch created from migrations alone fails at `20260706000000` ("cannot change return
  type") — create test branches `with_data: true` until the replayable-history ticket is closed.
- Signed storage URLs rotate their `?token=`; key caches on the object path, never the full URL.
- `drawer.id` has no DB default — tidyCAM generates it. A fresh insert from the portal must supply one.
- Legacy `drawer.dimensions` JSON drift: read `height ?? length`, `unit ?? units`,
  `top_color/base_color ?? colors.*` until the column backfill lands.
- `tidyCAD` corner points in `dimensions.correction` are ortho-photo pixels; `reference_corners` are
  normalized. Don't mix them.
- In the Cowork sandbox, git leaves `index.lock` behind; on the Mac mini grant delete permission on
  the repo folder before unattended runs.
- `db_apply.py` 401 "JWT could not be decoded" = stale/absent personal access token, not a DB error.

## Definition of done (every change)

- [ ] `npm run typecheck` clean; relevant `test:*` green; `next build` clean when routing/server code changed
- [ ] Renders on desktop and mobile widths; no console errors
- [ ] `docs/`: every link/anchor resolves, the quote form still submits, no hotlinked images
- [ ] Brand tokens used (`docs/assets/css/styles.css` `:root` vars), no one-off colors
- [ ] PR body = Done-when ✓/✗ + `verification.md` + reviewer verdict + "hardware sign-off: y/n"
      + a one-line customer-visible changelog entry when the change is customer-visible

## Where things are

- `planning/STATUS.md` — cross-repo status (read first in every session; the dispatcher rewrites it).
- `planning/contracts/` — the system contracts (status model, boxes, captures, calibration, DXF
  boundary). Any PR touching the `contract_globs` in `.claude/team.json` (migrations, pricing,
  `types.ts`, `dxf.ts`, `labels.ts`, contract docs) gets the Systems Engineer review lens.
- `planning/dev-environment-handoff.md` — dev/prod environment facts; open it before touching env.
- `portal/supabase/migrations/README.md` — migration rules and the byte-exact verification query.
- `.claude/team.json` — what the agents read: commands, board ids, contract globs, budget caps.

## Working with the agents

Feature requests enter through `/feature` (Program Manager intake → Todoist cards). The dispatcher
picks `agent-ready` cards from the tidyPortal board, implements in a worktree, has an independent
reviewer grade the diff, and opens a PR. Anything needing Sam becomes a Todoist task assigned to
him with label `needs-sam`. Design and rationale: project doc `claude/agent-dev-team-design-2026-10-21.md`.

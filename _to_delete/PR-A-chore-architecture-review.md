## PR A — `chore/architecture-review` → `main`

**Title:** chore: architecture review 2026-09-10 — dead code, doc drift, review + diagrams

### What this is

The safe half of a formal architecture review of the whole repo (marketing site, portal,
Supabase schema/RPCs, tooling, docs). Everything here is LOW-RISK under CLAUDE.md §4 —
no change to the quote form, auth, RLS, migrations, or mutation semantics — so it can
merge without a gate. The high-risk half is PR B, stacked on this branch.

### Commits

1. **`chore(portal)`: dead exports, stale branches, CSS tokens, repo hygiene** — every
   removal confirmed by `knip` and grep, `tsc --noEmit` clean, `next build` green.
   - Removed unused server actions `setCustomerOrgAction`, `assignDrawerToBoxAction`,
     `setDrawerQuantityAction`, `createQuoteAction` (exported actions are live HTTP
     endpoints — dead ones widen the surface for free) and `getUserEmail`.
   - Removed the two "apply the migration in `portal/supabase/migrations/`" branches
     from the dashboard and labels pages (RPCs live since June/August); a failed
     `get_my_drawers` now shows an error banner instead of stale copy.
   - `DrawerEvent.event_type` now matches the `drawer_event` CHECK constraint.
   - Added `--c-warn` tokens + `.banner--warn` (QuotesSection referenced a class that
     didn't exist); components use real tokens instead of `--c-brand`/`--c-muted`
     fallbacks; dropped 3 dead portal CSS rules and 6 dead marketing CSS rules.
   - Added `admin/error.tsx` so a thrown server action shows a message + retry instead
     of Next's generic production error page.
   - Untracked `tools/__pycache__/*.pyc` (one had no source file), ignored `__pycache__/`,
     `*.pyc`, `.venv/`; deleted an unreferenced 112 KB PNG; fixed a sitemap `lastmod`.
2. **`docs`: CLAUDE.md, READMEs, ROADMAP, planning notes match what is live** — the
   portal is on Vercel with the durable identity model; no Tally placeholder; GitHub
   Pages not Cloudflare; PRs #17/#34 are merged; `20260703220000` IS applied to prod
   (verified in the history table); the migration replay failure is `get_admin_customers`,
   not `get_my_drawers`, and the previously documented fix would have broken the
   Customers tab; new migration rules (apply-time timestamps, re-assert grants after
   DROP+CREATE, `db_apply.py`, mirror to `dev`).
3. **`docs(planning)`: the review itself** — `planning/architecture-review-2026-09-10.md`
   (findings register with IDs, dead-code ledger, adversarial review, three-horizon
   improvement roadmap, decisions needed) and `planning/architecture-diagram.md` (six
   Mermaid diagrams: context, portal topology, data model, drawer state machine,
   approval/notification sequence, environments + contract surfaces).

### Verification

- `tsc --noEmit` clean; `next build` green (all 16 routes); `npm run test:pricing` 36/36.
- `knip` after the change: 0 unused exports in `src/app`/`src/lib` (remaining
  "unused" are test files and the Deno edge function, which knip can't see).
- All six Mermaid blocks render with `mermaid-cli`.
- Live read-only checks on prod backed the doc corrections (migration history table,
  security advisor, `pg_indexes`).

### Definition of done

- [x] Renders on desktop and mobile (CSS removals are unused selectors only)
- [x] Nav/anchors resolve; quote form untouched (0 broken links in a full crawl)
- [x] No console errors; no hotlinked images
- [x] Brand tokens used (this PR *removes* hard-coded fallbacks)
- [x] ROADMAP.md updated

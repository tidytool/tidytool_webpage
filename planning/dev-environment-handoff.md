# Dev environment — handoff for Sam (build-out steps + outstanding issues)

State as of 2026-08-13. Almost everything is built and committed; this doc is
the complete punch list to finish the dev environment and clean up what was
found along the way. Background: `planning/SUPABASE.md` (strategy),
`planning/portal-launch-runbook.md` §1 (exact env values).

## What already works (no action)

- Dev database: persistent Supabase branch `gfkrebuioszsxanjdnsx`, used by
  tidyCAM (`APP_ENV=dev` builds) and tidyCAD (default from a checkout).
- Dev auth: `shem@thetidytool.com` exists with admin+staff (prod password
  hash); redirect allowlist covers localhost + Vercel preview wildcards.
- Portal code is env-ready; invite links use the per-deploy URL on previews.
- docs/ approve + drawer pages take `?env=dev` (green DEV badge, default prod).
- `tools/db_apply.py` applies migrations (byte-faithful history rows) and
  `--check` audits dir↔history parity. Prod checks OK 45/45.
- Policies: **dev is employees-only** (customers never get preview URLs or dev
  logins); commercial-launch checklist (Vercel Pro) is in the runbook.

## Build-out steps, in order

1. **[Sam, 5 min, dashboard] Set Vercel Preview env vars** on the existing
   portal project (`samochristensens-projects` account) — the ONLY step
   needed to turn the dev environment on. Exact values: runbook §1. Preview
   scope: dev URL + dev publishable key + dev secret key; leave
   `NEXT_PUBLIC_SITE_URL` unset. Production scope: untouched.
2. **Verify a preview**: push any branch (e.g. `feat/dev-environment`), open
   the preview URL, log in as shem@ (prod password), confirm the data shown
   is dev data (e.g. order "test test test test").
3. **Test the email-relink feature against dev** (iPad `APP_ENV=dev` build +
   the preview portal): "same customer new email" mode, "reassign" mode, the
   23505 conflict message, and reassign-to-an-email-that-has-a-login
   (auth-link backstop). Migration `20260813190000` is applied to dev only.
4. **Apply the relink migration to prod** (after step 3 passes, Sam's call):
   `python3 tools/db_apply.py portal/supabase/migrations/20260813190000_order_email_change_and_reassign.sql --env prod --approved`
5. **Merge the two branches** into `main`:
   - `feat/order-email-relink` (the migration file + its commit)
   - `feat/dev-environment` (env plumbing, docs switch, db_apply, docs)
   Merging main auto-deploys GitHub Pages + Vercel Production — both changes
   are production-safe (docs pages default to prod; portal change only affects
   the invite-link fallback).
6. **Post-merge parity check**: `python3 tools/db_apply.py --check --env dev`
   and `--env prod` should both report 1:1 (46/46 once 4+5 are done).

## Outstanding issues found during the build, with fixes

| # | Issue | Fix |
|---|---|---|
| 1 | **Schema-only Supabase branch replay is broken**: fresh branches stop at migration 16/46 (`20260706000000` does CREATE OR REPLACE on `get_my_drawers` with a changed return type). | Amend that migration file AND its history rows on dev+prod identically (add a `drop function if exists` guard) so parity holds and replay works. Until then: always create test branches `with_data: true`. |
| 2 | **Migration history rows aren't all byte-verifiable**: only the ten 2026-07-03 baseline rows (and future `db_apply.py` rows) match files byte-for-byte; MCP-applied rows are normalized, and the three 2026-08-12 tidyCAM rows have NULL statements. | Nothing urgent — `db_apply.py --check` treats version+name as the contract and reports verifiability. Optionally backfill the NULL/normalized rows with file bytes (same edit on dev+prod). |
| 3 | **`20260703220000_baseline_storage_policies` README note is stale**: `portal/supabase/migrations/README.md` says "NOT yet applied to prod", but prod's history table now contains that version. | Verify the storage policies are live on prod, then update the README note. |
| 4 | **tidyCAD's local `.env` holds a prod `sb_secret_*` key** (bypasses RLS); `.env.dev.bak` holds an old dev secret. | Rotate both keys in the dashboard, put the prod *publishable* key in tidyCAD's `.env`, delete `.env.dev.bak`, and add a secret-key rejection guard to `tidytool/environment.py` (tidyCAM already has one). |
| 5 | **tidyCAM's committed `supabase/schema.sql` is empty**, so its release-time schema diff has no baseline. | Run its `check_release_env.sh` schema pull once and commit the result (tidyCAM repo). |
| 6 | **Vercel Hobby plan is non-commercial**; portal must move to Pro before the first paying customer. Shem's empty "Manifest Systems" Vercel team is the future home — keep it empty until then so it never bills. | Runbook "Commercial-launch checklist". |
| 7 | **GitHub Pages non-commercial clause** for docs/. | Existing roadmap item: Cloudflare Pages migration (also enables making the repo private). |

## Cost guardrails

Everything above is $0: previews are free on the existing Vercel project, the
dev DB branch was already running (~$10/mo, shared by all three apps), and
disposable test branches get deleted same-day. The only future spend is
Vercel Pro at commercial launch (issue 6).

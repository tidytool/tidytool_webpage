# SUPABASE.md — the one shared backend, and how three repos use it safely

Canonical reference for the Supabase setup shared by **tidytool_webpage** (this
repo — owns the schema), **tidyCAM** (iPad operator app), and **tidyCAD**
(desktop design app). The sibling repos link here instead of keeping their own
copies of these rules. Last updated 2026-08-13.

## Environments

| Environment | Ref | What it is | Who points at it |
|---|---|---|---|
| **prod** | `tkrrvpoupekrjqditupi` | The live database | Portal (Vercel Production, `app.thetidytool.com`); docs/ link pages by default; tidyCAM prod builds; tidyCAD `--env prod` / frozen builds |
| **dev** | `gfkrebuioszsxanjdnsx` | Persistent Supabase branch — the shared integration/test environment | Portal local dev + **all Vercel Preview deploys**; docs/ pages with `?env=dev`; tidyCAM `APP_ENV=dev` builds (green DEV ribbon); tidyCAD default from a checkout |
| disposable branches | created ad hoc | Migration test beds | Created `with_data: true` (data clone), tested, **deleted when done** (they bill) |

Notes on dev:

- **Dev is for employees only** (policy 2026-08-13). Customers never get a
  preview URL, a `?env=dev` link, or a dev login; the only customer-facing
  surfaces are `app.thetidytool.com` and thetidytool.com, on prod.
- Dev **auth users are separate** from prod, seeded by hand.
  `shem@thetidytool.com` exists on dev with admin+staff roles. Redirect
  allowlist covers localhost and the Vercel preview wildcards (set 2026-08-13).
- Dev deliberately lacks `pg_net`, so notification emails never fire from it.
- End-to-end testing story: an `APP_ENV=dev` iPad build, a Vercel preview (or
  `npm run dev`), and `?env=dev` docs pages all see the same dev data.

## Who owns what

- **This repo owns the schema.** `portal/supabase/migrations/` is the single
  source of truth and mirrors each environment's
  `supabase_migrations.schema_migrations` history 1:1 by version+name
  (`portal/supabase/migrations/README.md` has the full rules).
- **Migrations are authored directly into this repo** — including changes
  driven by tidyCAM or tidyCAD work. All three repos live on the same machine;
  a session in any repo writes the migration file *here*, not into its own
  repo. This ends the author-in-tidyCAM-then-copy flow (tidyCAM's
  `supabase/migrations/` is a historical mirror only; tidyCAD's `docs/sql/` is
  a historical record only).
- **Clients degrade, never migrate.** tidyCAM and tidyCAD ship
  fallbacks for missing columns/RPCs (e.g. tidyCAM's boundary-column retry,
  tidyCAD's `RpcMissingError`) so one build works against both databases
  mid-rollout. The portal hand-maintains RPC shapes in
  `portal/src/lib/types.ts` ("keep in sync with the SQL").

## The change flow (any repo, any schema change)

1. **Author** the migration in `portal/supabase/migrations/`
   (`YYYYMMDDHHMMSS_snake_case.sql`, UTC timestamp, header comment:
   what/why/rollback/verification).
2. **Test on a disposable branch** — create with `with_data: true` (a
   schema-only branch will NOT work; see known issues), apply, run the
   scenarios, delete the branch.
3. **Apply to dev**: `tools/db_apply.py <file> --env dev`. The script runs the
   SQL via the management API, records the history row byte-faithfully, and
   verifies the md5.
4. **Integration-test against dev** from the clients that care (iPad dev
   build, Vercel preview, `?env=dev` pages).
5. **Apply to prod** — gated on Sam's explicit approval, no exceptions:
   `tools/db_apply.py <file> --env prod --approved`.
6. **Parity check any time**: `tools/db_apply.py --check --env dev|prod`
   (version+name 1:1 is the hard contract; the tool also reports how many rows
   are byte-verifiable).

## Known issues / standing tickets

- **Schema-only branch replay is broken** at
  `20260706000000_portal_durable_model_and_admin` (`CREATE OR REPLACE` with a
  changed return type on `get_my_drawers`); fresh schema-only branches stop at
  16 of 45+ migrations. Workaround: data-clone branches. Real fix: amend that
  file *and* the dev+prod history rows identically so parity holds and replay
  works.
- **History rows have three provenance classes**: the ten 2026-07-03
  materialized baseline rows (byte-faithful), MCP-applied rows
  (comments/whitespace normalized — not byte-comparable), and hand-recorded
  rows with NULL statements (the three 2026-08-12 tidyCAM migrations).
  Rows written by `db_apply.py` are byte-faithful; over time the verifiable
  share grows.
- **tidyCAD credentials**: its local `.env` holds a prod `sb_secret_*` key
  (bypasses RLS) and `.env.dev.bak` an old dev secret. Rotate both, switch
  tidyCAD to publishable keys, and add a resolver guard like tidyCAM's
  secret-key rejection.
- **tidyCAM's committed `supabase/schema.sql` is empty**, so its release-time
  schema diff currently has no baseline to compare against.
- `20260813190000_order_email_change_and_reassign` is applied to **dev only**;
  prod apply is pending Sam's approval (branch `feat/order-email-relink`).

## Secrets hygiene

Publishable (`sb_publishable_*`) and legacy anon keys are public by design —
safe in page source and committed examples. Secret keys (`sb_secret_*`,
service-role JWTs, `SUPABASE_DB_URL`) live only in gitignored `.env*` files,
Vercel env vars, or the dashboard — never in any of the three repos' history.

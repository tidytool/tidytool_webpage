# Migrations — source of truth for the `tidytool` schema

This directory mirrors the production migration history table
(`supabase_migrations.schema_migrations` on project `tkrrvpoupekrjqditupi`) **byte-for-byte**.
This repo owns DB migrations (ARCHITECTURE.md decision 1, 2026-07-03); tidyCAM consumes
generated types and never migrates.

## Provenance (T1 baseline, 2026-07-03)

The live schema was originally built by hand in the dashboard. A `db pull` baseline
(`20260628062931_remote_schema`) plus nine follow-up migrations were applied to prod via
the Supabase MCP, which records each migration's statements in
`supabase_migrations.schema_migrations` — but the repo only carried three files
(`0001`–`0003`, since renamed to their timestamped versions below). This baseline
materialized **all ten** history entries as files, extracted directly from the history
table and verified byte-identical.

Each file's content is exactly `array_to_string(statements, E';\n')` for its version.
Because of that, files intentionally have **no added headers and no trailing newline** —
do not "clean them up" or the verification below stops holding.

Verify any file against prod (read-only):

```sql
select version, md5(array_to_string(statements, E';\n'))
from supabase_migrations.schema_migrations order by version;
```

then compare with `md5sum *.sql` (strip the `<version>_<name>.sql` naming to match).

| version        | name                                        | md5 (verified 2026-07-03)          |
|----------------|---------------------------------------------|------------------------------------|
| 20260628062931 | remote_schema (baseline)                     | d1d976b1d23020fcb3ecc3cfff88f720 |
| 20260628073014 | add_customer_design_approval                 | 54fb346706a6a647c75e31a8000021c5 |
| 20260628154337 | allow_change_request_after_approval          | 2be829b83894165b5d780ef072724a6a |
| 20260628163738 | add_approval_changelog                       | 3a530dfbe7e7d238d6633113a9640c32 |
| 20260628164259 | lock_down_staff_and_internal_rpcs            | 50e1d0144084682d4ebe578cfab16e83 |
| 20260628164449 | harden_drawer_event_immutable_search_path    | 11533b106062f9335b9af37ba82d3106 |
| 20260628223234 | add_get_my_drawers (was `0001_…`)            | cc919b2b503c1da22b6645bc8780b021 |
| 20260629000251 | add_get_public_drawer                        | 48bcadcaa059d8d93fb8a0e8f6e64346 |
| 20260703160834 | harden_anon_reads (was `0002_…`)             | 2712bcc95e690861861943da1e43b93d |
| 20260703195701 | harden_round2 (was `0003_…`)                 | 966832a03d814fa98674bc445dccaa25 |

The old `0001`–`0003` files (with their prose headers) live on in git history; the history
table strips standalone comments, so the renamed files are the *applied* content.

## Known gaps the baseline does NOT cover

- **Pre-baseline storage policies.** `db pull` captured only `public`; the 8 storage
  policies created by hand before 2026-06-28 (`drawer_assets_*`, `auth upload/update
  drawer-assets`, `lidar_scans_*`) are not in the ten historical migrations, so a fresh
  branch reproduces the `public` schema exactly but misses them.
  `20260703220000_baseline_storage_policies.sql` closes this: it recreates all 8
  verbatim (branch-tested 2026-07-03 — after applying it, branch fingerprint == prod
  fingerprint exactly). **NOT yet applied to prod** (a behavior-no-op, but it writes
  migration history — gated on Sam). Until applied, fresh branches need it applied
  manually to be faithful.
- **Buckets, auth config, edge functions, Vault secrets** are not schema and are not here.

## Rules for new migrations

1. Name `YYYYMMDDHHMMSS_snake_case_name.sql` (UTC timestamp = the version).
2. Develop and test on a **disposable Supabase branch** only (pgTAP + advisors green),
   delete the branch when done.
3. Prod apply requires Sam's explicit approval — no exceptions. Apply with the same
   name so the history table and this directory stay 1:1.
4. Header comment (what/why/rollback/verification) is required for new files — the
   no-header rule above applies only to the ten materialized historical files.

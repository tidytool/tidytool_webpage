# Backend analysis & change-safety plan — Supabase `tidytool`

**Author:** Backend/DB review (Cowork) · **Date:** 2026-06-27 · **Status:** Analysis only — no changes made
**Project:** `tidytool` (ref `tkrrvpoupekrjqditupi`), Pro plan, Postgres 17.4, region us-west-1, compute `nano`

This is a read-only audit of the live database, storage, and config, measured against what
`ROADMAP.md` and `planning/FEATURE-profiles.md` say the backend must support. It also answers
the three things you asked for before we touch anything: a **backup/validation plan**, a
**test plan**, and a **map of Supabase built-ins** we should lean on.

---

## 1. TL;DR

The backend is **healthy and real** — this is production data, not a sandbox:

| Table | Rows | Notes |
|---|---|---|
| `order` | 55 | customer info denormalized as text columns |
| `drawer` | 100 | FK → `order`, generated `qr_url`, status enum |
| `customer` | 20 | **orphaned** — no FK points to it |
| `drawer_backup_2026_05_02` | 96 | manual backup table left in `public` |
| `employee` | 1 | anon-readable PII |
| `user_roles` | 1 | role gate for `is_admin()` |
| storage objects | 491 | across 2 public buckets |

It works, but it carries the hallmarks of a schema grown by hand in the dashboard rather than
through migrations. The **five things worth fixing before we build the approval feature** —
in priority order:

1. **Migrations aren't the source of truth.** Only *one* migration is tracked. The rest of the
   schema was created live in the dashboard. Until the schema is captured as migrations, we
   cannot safely branch, diff, or validate breaking changes — which is exactly what you asked
   to be able to do.
2. **Security debt is live, not theoretical.** `anon` can currently read every column of every
   `drawer` and every `employee` (names, phones). This is already noted in the roadmap; the
   approval feature writes data, so it's the right moment to close it.
3. **Duplicate / overlapping RLS policies** on `drawer` and on `storage.objects` — the broad
   policies cancel out the tighter ones, so the "secure" policies are currently doing nothing.
4. **Data-model drift:** the `customer` table is disconnected, and the order→drawer link is
   modeled twice (a real FK *and* a comma-separated `order.drawer_ids` text column).
5. **Platform hygiene:** Postgres has security patches pending; duplicate index and an
   unindexed FK on `drawer`; leaked-password protection off.

None of this blocks the approval feature. But fixing 1–3 first is what makes the approval
feature *safe to ship* and gives you the "validate breaking changes against a backup" workflow
you want. Details below.

---

## 2. What's actually there

### 2.1 Tables (public schema)

**`order`** (55 rows) — `id`, `created_at`, `customer_name`, `project_name`, `customer_email`,
`customer_phone`, `location`, `notes`, `drawer_count`, `total_price` (int8), `drawer_ids` (text),
`created_by` (uuid, default `auth.uid()`).

**`drawer`** (100 rows) — `id`, `created_at`, `order_id` → `order.id`, `photo_url`,
`dimensions` (json), `dxf_url`, `nickname`, `status` (enum `drawer_status`), `created_by`,
`point_cloud_url`, **`qr_url`** (generated column:
`'https://thetidytool.com/q/?d=' || id` — nicely done, this is the permanent QR contract baked
into the DB).

**`customer`** (20 rows) — `id`, `created_at`, `name`, `phone`, `email`. **RLS enabled, zero
policies** → unreachable by `anon`/`authenticated`; only the service role sees it.

**`employee`** (1 row) — `id`, `phone`, `name_first`, `name_last`, `catchphrase`, `created_at`.

**`user_roles`** (1 row) — `user_id` → `auth.users`, `role` (`admin`|`user`). Backs `is_admin()`.

**`drawer_backup_2026_05_02`** (96 rows) — a hand-rolled copy of `drawer`, no primary key, RLS
enabled with no policy. Snapshot left in the production schema.

`drawer_status` enum: `backlogged_by_admin → created_by_user → received_by_tidydesk →
processed_by_tidydesk → approved_by_qualityctrl → received_by_fabricator`.

### 2.2 Storage

Two buckets, **both public**: `drawer-assets` (491-ish objects, since 2025-08) and `lidar_scans`
(since 2025-10). Public means object URLs render directly in `<img>` — which the QR drawer page
relies on, so that's intentional and fine.

### 2.3 Functions, migrations, edge functions

- Functions: one — `public.is_admin()`, `SECURITY DEFINER`, returns boolean.
- Migrations tracked: **one** — `20260625051606_add_drawer_qr_url_generated_column`.
- Edge functions: **none deployed.**

### 2.4 Extensions

Installed: `uuid-ossp`, `pgcrypto`, `pg_stat_statements`, `supabase_vault`, `plpgsql`.
Available but not installed and relevant to us: **`pgtap`** (DB unit testing), **`pg_net`**
(async HTTP — could POST to Discord from the DB), `pg_cron`, `citext`, `pg_jsonschema`.

---

## 3. Data-model assessment (senior review)

What's good: UUID PKs, `created_by` defaulting to `auth.uid()`, the **generated `qr_url`** column
(permanent QR contract enforced in-schema — exactly right), and a meaningful status enum.

What I'd flag:

**a. The `customer` table is orphaned.** Nothing references it. Customer identity lives
denormalized on `order` as `customer_name` / `customer_email` / `customer_phone` text. So there
are two competing notions of "customer" and they aren't linked. *Question for you / tidyCAM:* is
`customer` written by the app for a reason, or is it dead? This decides whether the approval
feature keys off `order` or off a real `customer` row.

**b. The order→drawer link is modeled twice.** There's a proper FK (`drawer.order_id → order.id`)
*and* a denormalized `order.drawer_ids` text column (comma-separated). **Resolved 2026-06-27 via
the tidyCAM source:** the app actively writes *and* reads `drawer_ids`, so it is **load-bearing —
do not retire.** It's redundant with the FK by design; any future normalization must change the
app first.

**c. `total_price` is integer CENTS.** **Resolved 2026-06-27:** the tidyCAM `OrderRecord` model
stores `(price*100).round()` and reads `value/100`; live rows (11100, 14025, 15656 = $111.00,
$140.25, $156.56) confirm it. Treat the column as cents everywhere; do not read it as dollars.

**d. `drawer_backup_2026_05_02` in `public`.** A PII-bearing copy with no RLS policy and no PK,
sitting next to live tables. This is the manual-backup anti-pattern we should replace with the
branch/PITR workflow in §5 — then archive and drop it.

---

## 4. Security findings (live)

Sourced from Supabase's own advisors plus the policy dump. Severity in brackets.

1. **[WARN] `anon` can read all of `drawer` and all of `employee`.** Both tables carry an
   `"Enable read access for all users"` policy with `USING (true)` for the `public` role. The anon
   key (shipped in page source) can therefore read **every column of every drawer** — including
   `dxf_url`, `point_cloud_url`, `created_by`, `order_id` — and **all employee names/phones**.
   This is the debt already logged in `ROADMAP.md`. Fix: replace with a `SECURITY DEFINER` function
   returning only public-safe drawer fields, drop the blanket policies. (Matches the roadmap's
   stated plan.)

2. **[WARN] Duplicate / overlapping RLS policies cancel each other out.** `drawer` has *two*
   INSERT policies, *two* SELECT, *two* UPDATE. Because permissive policies are OR'd, the broad
   `"drawers …"` / `"Enable read access"` policies override the tighter, correct
   `drawer_*_authenticated` ones — so the strict policies are currently inert. Same pattern on
   `storage.objects`: `"auth read/upload/update drawer-assets"` (bucket-only check) sit alongside
   the path-and-owner-scoped `drawer_assets_*` policies and neutralize them. Net: storage access
   is far broader than the careful policies suggest.

3. **[WARN] Public bucket allows listing.** `drawer-assets` is public *and* has a broad SELECT
   policy on `storage.objects`, letting clients **enumerate every file** in the bucket. Public
   buckets don't need a SELECT policy for URL access — this just leaks the file list.

4. **[WARN] `is_admin()` is executable by `anon`.** A `SECURITY DEFINER` function callable
   unauthenticated via `/rest/v1/rpc/is_admin`. Likely harmless (returns a bool) but should have
   `EXECUTE` revoked from `anon`.

5. **[WARN] Postgres has security patches pending** (`supabase-postgres-17.4.1.064`). Schedule an
   upgrade — this is a one-click platform action but a breaking-change candidate, so do it via the
   validation flow in §5.

6. **[WARN] Leaked-password protection disabled** + **[INFO] Auth uses absolute (10) DB
   connections.** Low effort, worth flipping on / switching to percentage-based.

7. **[INFO/WARN performance]** Unindexed FK `drawer.order_id`; **duplicate index** on `drawer`
   (`drawer_id_key` == `drawer_pkey`, drop one); RLS policies call `auth.uid()` un-wrapped so it
   re-evaluates per row (wrap as `(select auth.uid())`). Cheap wins, meaningful at scale.

---

## 5. Backup & breaking-change validation plan (your main ask)

The goal you stated: **be able to validate breaking changes against a backup before they hit
production.** Here's the senior-dev answer, cheapest-first. The foundation has to come first
because everything else depends on it.

### 5.0 Prerequisite — make migrations the source of truth

Right now the schema is "whatever is live," with only one migration recorded. You cannot reliably
diff, branch, or roll back what was never captured. **Step zero** is to baseline the current
schema into migration files (one-time `supabase db pull` / schema dump committed to the repo).
After that, every change is a migration, reviewed like code. This is what turns "validate against
a backup" from a hope into a process.

### 5.1 Three layers of safety

1. **Point-in-Time Recovery (PITR) / backups — the safety net.** Your Pro plan takes daily
   backups (dashboard shows "last backup 13h ago"). Confirm whether PITR is enabled; if not,
   enabling it gives second-level rollback granularity. This protects against data loss, *not*
   against shipping a bad schema — that's what branches are for.

2. **Supabase Branches — the validation environment (recommended primary tool).** Pro includes
   database branching: spin up an isolated copy of the project (schema + a seed of data), apply
   the migration there, run the test suite (§6) and the advisors, eyeball it, then **merge to
   production** only when green. This is the native equivalent of a staging DB and directly
   delivers "validate breaking changes against a backup." Currently: no branches exist.

3. **Pre-flight snapshot before any destructive merge.** Immediately before merging a risky
   migration to prod, take a fresh backup/restore point so rollback is one step. This *replaces*
   the manual `drawer_backup_YYYY_MM_DD` table pattern — branches + PITR do the same job without
   leaving PII copies in `public`.

### 5.2 The workflow we'd use for every change

```
write migration  →  open Supabase branch  →  apply migration on branch
       →  run pgTAP + smoke tests on branch  →  run security & perf advisors
       →  Sam reviews  →  merge to production  →  re-run advisors on prod
```

Nothing touches production until it's passed on a branch. Rollback = revert the migration +
restore the pre-merge point.

### 5.3 Cleanup that falls out of this

Once branches/PITR are the backup mechanism, **archive and drop `drawer_backup_2026_05_02`** (dump
it to cold storage first). It's stale (May), PII-bearing, and policy-less.

---

## 6. Test strategy (unit + smoke)

Two layers, both runnable on a branch before merge.

### 6.1 Database unit tests — `pgTAP` (already available, just enable)

`pgtap` is in the extension catalog. Write SQL tests that assert the security model *as code*, so
a future change that re-opens a hole fails the build:

- **RLS truth tests** — as `anon`: can read a public drawer's safe fields, **cannot** read
  `dxf_url`/`point_cloud_url`/`employee`/`order`/`customer`, cannot list a bucket. As customer A:
  can read own order/drawers, **cannot** read customer B's. As admin: can read all.
- **RPC contract tests** — the public-drawer function returns only whitelisted columns; the
  approval RPC writes exactly one immutable row and flips status; a second approval can't mutate
  the first.
- **Constraint tests** — approval requires a non-empty signer name; token is unique; status
  transitions are legal.

### 6.2 Smoke tests — REST against a branch

A small script (curl/Node, no new runtime deps) that hits the live PostgREST/Storage endpoints
with the **anon key** and asserts end-to-end:

- `GET` a known public drawer by id → 200, safe fields only.
- `GET` list of all drawers / an employee row → blocked.
- Approval happy path: open token → submit name → `Approve` → row written, status changed,
  Discord webhook fired (to a test channel) → second approve rejected.
- Bad-token / already-approved / empty-name → correct errors.

Run both suites in the branch step of §5.2. Long-term these can run in CI on every migration PR.

---

## 7. Supabase built-ins we should leverage (don't rebuild these)

| Need | Built-in to use | Status |
|---|---|---|
| Validate breaking changes | **Database Branches** | Available, unused |
| Backups / rollback | **Daily backups + PITR** | On; confirm PITR |
| Keep Discord webhook URL secret | **Vault** (`supabase_vault`) | Installed, unused |
| Notify Discord on approval | **Edge Function** (preferred) or **`pg_net`** trigger | None deployed |
| Public-safe data exposure | **`SECURITY DEFINER` RPC** behind RLS | Pattern already used (`is_admin`) |
| DB unit testing | **`pgTAP`** | Available, not enabled |
| Catch regressions | **Advisors** (security + performance) | Available — fold into §5 flow |
| Permanent QR contract | **Generated column** (`qr_url`) | Already done — good |
| Passwordless approval identity (future) | **Auth magic links** | Available |
| Schema-validate JSON (`dimensions`) | **`pg_jsonschema`** | Available |

For the approval notification specifically: store the Discord webhook URL in **Vault**, and fire
it from an **edge function** (cleaner secret handling and retries) or a **`pg_net`** call in the
approval RPC. Either keeps the webhook out of page source — which was your requirement.

---

## 8. How this lands the approval feature

The approval feature itself stays small (one `approval_request` table + one public read RPC + one
approval RPC + Discord notify). But doing it *on top of* the fixes above means it ships on a clean,
tested, branch-validated base instead of widening existing holes. Proposed order:

1. Baseline schema into migrations (§5.0). *No behavior change.*
2. Enable `pgTAP`; write tests that lock in the **current** intended security model (§6.1).
3. Open a branch; fix the security debt (§4.1–4.4) + perf nits (§4.7); validate; merge. *This is
   the roadmap's existing "Supabase hardening" item — now test-backed.*
4. Build `approval_request` + RPCs + Discord notify on a branch; test; review; merge.
5. Schedule the Postgres upgrade (§4.5) through the same branch flow.

Steps 1–2 are pure safety scaffolding and change no behavior, so they're the natural first move
and they're what make 3–5 reversible.

---

## 9. Open questions — resolved 2026-06-27 (verified against tidyCAM source + live data)

1. **`customer` table** — DEAD. Zero references in the Dart app; orphaned. Approval feature keys
   off `order`.
2. **`order.drawer_ids`** — actively used by the app (write + read). **Keep it.** Not a retirement
   candidate; normalize only after changing the app.
3. **`total_price`** — **integer cents**, not dollars (app does ×100 / ÷100). Treat as cents.
4. Baseline method — **CLI `db pull`** chosen (see `DB-baseline-runbook.md`). Backup/validation
   via **Supabase branch**.

### Still open (new, surfaced from the tidyCAM repo)

5. **Migration ownership.** tidyCAM is already `supabase link`ed to this project and carries a
   stale `supabase/schema.sql` (Feb, pre-`qr_url`, flat dump). Two repos touching one DB invites
   drift. **Decide a single home for DB migrations** before baselining — likely tidyCAM (it owns
   the schema/ingestion) or a dedicated infra repo, with the webpage repo consuming, not owning.

*No database changes have been made. This document is analysis and proposal only.*

# DB baseline runbook — capture live Supabase schema into migrations

> **SUPERSEDED 2026-07-03.** Migration ownership moved to **this repo**
> (`portal/supabase/migrations/`) per `ARCHITECTURE.md` decision 1; tidyCAM consumes
> types and never migrates. The baseline itself was completed 2026-07-03 (T1): all ten
> prod history entries were materialized byte-exact from
> `supabase_migrations.schema_migrations` — see `portal/supabase/migrations/README.md`
> for provenance and verification. The CLI procedure below is kept for reference only.

**Home for DB migrations: the `tidyCAM` repo** (decided 2026-06-27, superseded — see above). It owns the data model, is
already linked to the project, and is private (the webpage repo is public, so schema + RLS logic
must not live there). The website repo stays pure frontend and reads over REST.

**Goal:** record the current live `tidytool` schema as a migration in **tidyCAM**, so migrations
become the source of truth and Supabase **branches** can faithfully reproduce the schema for safe
validation. `db pull` only *reads* the live schema — **no DDL runs on production.**

Run these on your MacBook from the **tidyCAM** repo root
(`/Users/samchristensen/Documents/Development/tidyCAM`). Paste any errors back to Claude rather
than improvising.

## Current state of tidyCAM/supabase (already checked)

- Linked to project `tkrrvpoupekrjqditupi` (`.temp/project-ref` confirms). ✅
- Has a local `schema.sql` + `storage_policies.sql` — a **stale, untracked** Feb dump
  (pre-`qr_url`, not migrations). We'll let `db pull` supersede it.
- **No `config.toml`, no `migrations/` folder** — not fully `init`ed yet.
- **`supabase/**` is gitignored** (`.gitignore` line 49) — so nothing under `supabase/` is
  tracked. We must narrow that ignore so `config.toml` and `migrations/` get committed.

## 0. One-time install (skip if already installed)

```bash
brew install supabase/tap/supabase
supabase --version
```

If `db pull` later complains about Docker, start **Docker Desktop** and re-run.

## 1. Initialize (creates config.toml; keeps existing link)

```bash
cd /Users/samchristensen/Documents/Development/tidyCAM
supabase init        # creates supabase/config.toml; say "no" if it asks to overwrite anything
```

## 2. Confirm the link (already linked, but re-run to be safe)

```bash
supabase link --project-ref tkrrvpoupekrjqditupi
```

It will prompt for the **database password** (dashboard → Project Settings → Database). The
password is stored in `supabase/.temp/` (gitignored) — never commit it.

## 3. Pull the live schema into a migration

```bash
supabase db pull --debug          # --debug so we can see what it's doing
```

When it prompts **"Enter your database password"**, paste the DB password (dashboard → Project
Settings → Database → Database password; reset there if unknown). A *blank* entry makes it skip
silently and write nothing — which is what happened on the first try.

It should then write `supabase/migrations/<timestamp>_remote_schema.sql`.

- If the CLI reports a **history mismatch** and suggests `supabase migration repair … --status
  applied`, **stop and paste the exact message to Claude** before running it.

### Fallback if `db pull` still writes nothing

`db pull` uses a local shadow DB (needs **Docker Desktop running**). If it keeps producing no
file, skip it and dump the schema directly — this reliably writes a baseline migration:

```bash
mkdir -p supabase/migrations
supabase db dump --schema public -f "supabase/migrations/$(date -u +%Y%m%d%H%M%S)_baseline.sql"
```

`db dump` connects to the remote (it'll use the linked password or prompt) and writes the full
`public` schema — tables, enums, `is_admin()`, RLS policies — as one baseline file. Paste the
last ~20 lines of output back to Claude either way.

## 4. Fix `.gitignore` so migrations get tracked

Replace the single broad line `supabase/**` (line ~49) with the standard Supabase ignore set —
this tracks `config.toml` and `migrations/` while still ignoring local/secret bits:

```gitignore
# Supabase — track config + migrations, ignore local/secret state
supabase/.branches
supabase/.temp
supabase/schema.sql
supabase/storage_policies.sql
```

(We keep the old `schema.sql`/`storage_policies.sql` ignored — they're superseded by the
migration. You can delete them locally once the pull looks right.)

## 5. Review and commit

```bash
git add supabase/config.toml supabase/migrations .gitignore
git status                        # confirm: no .temp, no password, no schema.sql
git commit -m "Baseline live Supabase schema into migrations (tidyCAM owns DB)"
```

Skim `supabase/migrations/<timestamp>_remote_schema.sql` — it should contain `create table` for
`order`, `drawer`, `customer`, `employee`, `user_roles`, the `drawer_status` enum, `is_admin()`,
and the RLS policies.

## 6. Hand back to Claude

Tell Claude **"baseline pushed"** and paste the migration filename + the last ~15 lines of the
`db pull` output. Claude then (via MCP): creates a dev branch (~$0.0134/hr, deleted after),
enables `pgTAP`, runs RLS/security tests, checks advisors, and reports before anything merges.

---

### After baseline (Claude's side, for reference)

1. `create_branch` → branch replays the baseline = faithful schema copy.
2. `apply_migration` on the branch: enable `pgTAP` + RLS/RPC tests.
3. Run tests + security & performance advisors on the branch.
4. You review → merge to production. The approval-feature migration and the security-debt fixes
   follow the same branch-first loop, all committed in **tidyCAM**.

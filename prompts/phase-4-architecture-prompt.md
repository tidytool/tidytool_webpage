# Implementation Prompt — Phase 4: Portal Integration Architecture

## Role

You are a senior full-stack engineer (Postgres/Supabase + Next.js) implementing the
approved integration architecture for TidyTool's customer portal. You work in small,
reviewable increments, verify everything you claim, and stop at every gate that
requires the owner's (Sam's) approval. You are one of several agents that may touch
this repo — leave it cleaner and better-documented than you found it.

## Required reading — in this order, before writing any code

1. `CLAUDE.md` — the working agreement. It overrides your defaults.
2. `planning/ARCHITECTURE.md` — the approved direction and ALL executive decisions
   (numbered 1–8). Do not relitigate decided questions.
3. `planning/DB-baseline-runbook.md` — how the schema baseline is done.
4. `planning/BACKEND-analysis.md` §5–6 — the branch-validated migration workflow and
   test strategy. §3 has data-model landmines.
5. `portal/README.md` — portal stack, auth flow, deploy facts.
6. `ROADMAP.md` — where this phase fits.

If anything you find in the codebase contradicts these documents, STOP and report the
discrepancy — do not silently pick a side.

## Business context

TidyTool makes custom CNC-cut foam tool organizers (Logan, Utah). The marketing site
(`docs/`, static, GitHub Pages) converts visitors to quote requests — its conversion
path is sacred. The portal (`portal/`, Next.js + Supabase, live at
https://app.thetidytool.com) is where customers approve designs before we cut. This
phase builds the durable data spine beneath it: real customer/organization identity,
a customer-facing lifecycle with an event timeline, notifications, and an admin view.

## Non-negotiable guardrails

- **Never push to `main`.** All work on feature branches (`feat/…`), one ticket per
  branch, PR described for Sam to review and merge. `main` auto-deploys BOTH the
  marketing site and the portal.
- **Database changes are developed and tested ONLY on disposable Supabase branches.**
  Delete the branch when the ticket closes (branches bill while alive). Applying any
  migration to production requires Sam's explicit approval — no exceptions, even for
  "safe" changes.
- **Never read, write, or commit secrets.** `portal/.env*` is off-limits; keys ship
  via Vercel env vars. The publishable/anon key is public by design; the service-role
  key must never appear in code, logs, or chat.
- **Do not touch:** the quote form / conversion path in `docs/`, auth flows beyond
  this spec, `drawer_status` enum values (tidyCAM/tidyDesk own it — decision 3),
  `order.drawer_ids` (load-bearing text column tidyCAM reads/writes), the generated
  `qr_url` column (permanent engraved contract).
- **Facts that will bite you:** `total_price` is integer CENTS. `drawer.created_by`
  is the tidyCAM operator, never the customer. 28 of 57 orders have unusable
  `customer_email` (decision 5 covers this — backfill clean rows, orphans wait for
  admin mapping). The 20 existing `customer` rows are test/debug data (decision 6 —
  purge in migration).

## Working practices (how you operate — not optional)

1. **Plan before code.** Open each ticket by writing a short plan: files to touch,
   migration contents, test list, risks. If the plan reveals an undecided question,
   ask before building.
2. **Read before write.** Never edit a file you haven't read. Never assume schema —
   inspect the live branch DB (`list_tables`, policy dumps) before writing SQL.
3. **Smallest change that meets the ticket.** No drive-by refactors, no new
   dependencies without sign-off, no speculative abstractions. If you notice unrelated
   debt, log it in the PR description — don't fix it in the same diff.
4. **Test-first where it counts.** For every migration: pgTAP tests asserting the
   security model (as anon / as customer A vs B / as admin) BEFORE applying to the
   Supabase branch, then advisors (security + performance) after. For portal code:
   `npm run build` + typecheck must pass; verify pages render with real branch data.
5. **Verify, don't assert.** Every claim in your report ("anon cannot read X") must
   be backed by a command you actually ran and its output. If you didn't run it, say so.
6. **One migration file per schema change**, numbered sequentially in
   `portal/supabase/migrations/`, with a header comment: what, why, rollback notes,
   and the verification queries.
7. **Idempotence and rollback.** Migrations use `if exists`/`if not exists` where
   sensible; destructive steps (dropping the stale customer rows) archive first
   (`create table _archive_… as select …`) and note the restore path.
8. **Commit hygiene.** Imperative subject, body explains why. Update `ROADMAP.md`
   and relevant planning docs in the same PR when a ticket changes direction-level
   state. Never commit generated junk (`.next/`, `tsconfig.tsbuildinfo`, node_modules).
9. **Stop conditions.** Stop and report rather than guess when: a prod apply is
   needed; a test fails for reasons you don't understand; the blast radius of a
   change is unclear; tidyCAM behavior is implicated; you'd need a secret; or two
   documents disagree.
10. **Report format per ticket:** what changed (files/migrations), what you verified
    (commands + results), what needs Sam (approvals, dashboard actions), what's next.

## Tickets — strictly in order, each gated on the previous

### T1 — Baseline the schema into migrations
Per `DB-baseline-runbook.md`. Capture the full live schema as the baseline in
`portal/supabase/migrations/`; reconcile the migration history so `0002`/`0003`
(already applied to prod via MCP) and the baseline coexist without drift. Deliverable:
a fresh Supabase branch comes up schema-identical to prod from migrations alone.
Verify with a schema diff (branch vs prod) that returns empty. **No behavior change.**
Backups confirmed current 2026-07-03 — you may proceed.

### T2 — Migration 0004: durable identity
On a Supabase branch, honoring decisions 1, 2, 5, 6:
- Extend `customer`: `auth_user_id uuid null references auth.users`,
  `organization_id uuid null`; archive-then-purge the 20 stale rows.
- New `organization` table (id, name, created_at).
- `order.customer_id uuid null references customer`, `order.organization_id uuid null`.
- Link-on-login trigger: on auth sign-in/creation, attach `customer.auth_user_id`
  where `lower(email)` matches.
- Backfill: distinct clean `order.customer_email` → customer rows; set
  `order.customer_id` for the ~29 clean orders; orphans stay null.
- RLS: customers read own row; org members read their org; admin reads all.
  Default-deny everything else. pgTAP the whole matrix.
Gate: Sam approves prod apply after branch results.

### T3 — Portal on the durable model + admin view
- `get_my_drawers` v2: key on `customer_id`; org-aware (whole-org visibility,
  decision from 6/28); keep the email bridge as fallback until backfill coverage
  is confirmed, then remove it in the same PR if green.
- Admin (via existing `user_roles`): admin RPC returning the full pipeline; portal
  admin page — pipeline queue, "assign order to customer" (the orphan-mapping tool,
  decision 5), "mark delivered" writing a `drawer_event` (decision 7).
- Non-admin customers must see zero change except correctness.

### T4 — Migration 0005: lifecycle + timeline
- `drawer_event`: shape review, RLS (customer reads events for own drawers; admin
  all; writes only via triggers/RPCs).
- Trigger on `drawer.status` change + approval RPCs → append events.
- Customer-state mapping (ops enum + approval state → scanned/designed/awaiting
  approval/approved/in fabrication) as a VIEW first (decision 3; cheapest, no write path).
- Portal: timeline component on the drawer/approval page.

### T5 — Notifications
After Sam completes SMTP setup (separate task): edge functions on lifecycle
transitions (design ready → "review your design"; approved → "we're cutting");
Discord webhook URL moved into Vault; customer emails only on the two transitions
named — no notification spam.

## Definition of done (every ticket)

- [ ] Branch-tested: pgTAP green, advisors clean (or regressions explained), build passes
- [ ] Verified claims only — commands and outputs in the report
- [ ] Migration files + docs updated in the same PR; ROADMAP.md updated if phase state changed
- [ ] Supabase branch deleted after merge decision
- [ ] PR ready for Sam with risks called out explicitly

# TidyTool integration architecture — database, scanning, portal

**Status:** Direction approved by Sam 2026-07-03 · **Owner:** Sam
**Supersedes** the architecture sections of `FEATURE-profiles.md` (its Phase B
label-entry spec remains valid future work). Companion docs: `BACKEND-analysis.md`
(DB audit), `DB-baseline-runbook.md` (baseline), `portal-launch-runbook.md` (launch).

## The idea

Three surfaces — tidyCAM (scan/intake), tidyDesk (design/ops), and the customer
portal — share one database but historically not one model. This architecture makes
the customer lifecycle explicit so every surface reads and writes the same state:

```
scanned → designed → awaiting approval → approved → cut → delivered
```

## Executive decisions (Sam, 2026-07-03)

1. **DB migrations live in THIS repo** (`portal/supabase/migrations/`). tidyCAM
   consumes generated types; it never migrates. Its stale `supabase/schema.sql`
   should be deleted or marked non-authoritative (cross-repo chore).
2. **Portal-first, backfill later.** Build the customer/org model + link-on-login
   trigger + a backfill from `order.customer_email` now; tidyCAM starts writing
   customer/org links at intake later. Portal value doesn't block on cross-repo work.
3. **Separate customer lifecycle.** `drawer_status` stays tidyCAM/tidyDesk's ops
   field, untouched. A customer-facing state + `drawer_event` log (table exists,
   unused) is derived from ops status + approval actions via trigger. Portal owns
   its own vocabulary; zero tidyCAM changes.
4. **Brand hedge holds until September 2026.** thetidytool.com remains the permanent
   URL contract either way (redirect layer survives a rename).

**Pre-flight decisions (Sam, 2026-07-03), driven by data audit:**

5. **Dirty order history** (28 of 57 orders have no usable `customer_email`; 44
   distinct names vs 27 distinct emails): backfill the clean orders now; orphaned
   orders stay admin-visible only, with a manual "assign to customer" action in the
   admin view later. No cleanup gate on migration 0004.
6. **Reuse the `customer` table** — its 20 existing rows match zero orders and are
   mostly test/debug data per Sam; purge/archive them in the migration, extend the
   table with `auth_user_id` / `organization_id`.
7. **"Delivered" is an admin action** in the portal admin view writing a
   `drawer_event` (the ops enum ends at `received_by_fabricator` and stays
   untouched). Timeline v1 ends at "in fabrication" until that ships.
8. **Agent working rules confirmed:** all code on git branches, Sam merges to main
   (main auto-deploys GitHub Pages AND Vercel); DB work only on disposable Supabase
   branches (deleted when done); every prod migration apply is gated on Sam's
   explicit approval.

## The six pillars

### 1. Identity: customer + organization first-class
- `customer` gets `auth_user_id → auth.users` (nullable until claimed) +
  link-on-login trigger matching `lower(email)`.
- `organization` table; `customer.organization_id` and `order.organization_id`
  nullable (solo customers exist). **Org visibility = whole org** (decided 6/28).
- `order.customer_id → customer` becomes the real link; `customer_email` stays as
  the claim/backfill key, never a foreign key.
- Backfill script: distinct `order.customer_email` → customer rows (27 emails today).
- Replaces the transitional `get_my_drawers()` email matching once landed.
- Admin = existing `user_roles` (role='admin') → admin RPC returning all orders +
  admin view in the portal.

### 2. Workflow: customer lifecycle + event log
- `drawer_event` (exists, no policies — needs RLS + shape review) records
  transitions: who, what, when. Written by trigger on `drawer.status` changes and
  by the approval RPCs.
- Customer-facing state is a mapping (ops enum + approval state → customer
  vocabulary), stored or view-derived — decide at implementation, favor a view
  first (cheapest, no write path).
- Portal renders the event log as an order timeline ("pizza tracker").
- Rule preserved from FEATURE-profiles: **nothing is cut without a customer
  approval record**; post-approval changes create a new approval round.

### 3. Notifications
- Edge function per lifecycle transition worth telling the customer about
  (design ready → "review your design"; approved → "we're cutting").
- Discord webhook (Sam-facing) stays; move its URL into Vault.
- Depends on custom SMTP (launch-hygiene item) for customer-facing email.

### 4. QR = physical-digital bridge
- Contract unchanged and permanent: `https://www.thetidytool.com/q/?d={drawer_id}`,
  baked into the DB as the generated `qr_url` column.
- Today: anon scan → public drawer page → quote CTA (referral channel).
- Next: same QR deep-links the owner into the portal (claim/login flow) for
  labels, reorder, status.

### 5. Admin/ops in the same portal
- Same codebase, `user_roles`-gated: pipeline queue (designs awaiting approval,
  approvals aging, ready to cut). Replaces Discord-as-ops-dashboard.

### 6. Retention layer (later, falls out of identity)
- Reorder-this-drawer → pre-linked order (designs/DXFs already stored).
- Org accounts + whole-org visibility = the future paid B2B fleet tier.
- Label entry ships when tidyCAM emits tool names (FEATURE-profiles Phase B).

## Build sequence

Each step ships value alone; DB changes ride the branch-validated migration flow
(`BACKEND-analysis.md` §5.2: branch → migrate → test → advisors → Sam review → merge).

1. **Baseline the schema into migrations** (`DB-baseline-runbook.md`) — prerequisite
   for safe branching/diffing. No behavior change.
2. **Migration 0004: identity** — customer.auth_user_id, organization, order FKs,
   link-on-login trigger, RLS for the new tables, backfill script.
3. **Portal switches to the durable model** — `get_my_drawers` v2 keyed on
   customer_id (org-aware), admin RPC + admin view.
4. **Migration 0005: lifecycle** — drawer_event RLS + trigger, customer-state
   mapping, portal timeline UI.
5. **Notifications** — edge functions + Vault + customer emails (after SMTP).
6. **tidyCAM intake linking** (cross-repo, when convenient) — retire the backfill.

## Constraints that don't change

- Marketing site (`docs/`) stays static, vanilla, conversion-first.
- Portal stays lean: server components, `@supabase/ssr`, no new heavy deps.
- High-risk changes (prod migrations, auth, RLS) get Sam's review; disposable
  Supabase branches are free to experiment on.
- `total_price` is integer **cents**; `order.drawer_ids` is load-bearing for
  tidyCAM — do not retire without changing the app first.

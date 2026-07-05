# FEATURE — T3.5: Admin CRM & order tracking (portal `/admin`)

**Status:** Spec approved-in-principle by Sam 2026-07-05 (chat) · **Priority: HIGH — active track**
**Owner:** Sam · Builds directly on T3 (`/admin` pipeline + orphan mapping + mark-delivered).

## Why

Sam is adopting `/admin` as the primary tool for managing all tracked orders — including
cleaning up and editing historical records (57 orders, 28 of which were orphaned; messy
names/emails from the pre-identity era). The portal becomes a lightweight CRM/order
tracker; Discord stops being the ops dashboard.

## What professional CRM/order tools have, filtered to what serves TidyTool now

Taken from the standard feature set of small-business CRM/order systems (HubSpot-style
contact management, Shopify-style order admin, Jobber/ServiceTitan-style job tracking),
cut down to a solo-operator shop with ~100 drawers:

| CRM staple | TidyTool translation | Tier |
|---|---|---|
| Contact records w/ edit | Edit customer name/email/phone; org assignment | v1 |
| Company/account grouping | Create/rename organizations; assign customers | v1 |
| Order editing | Edit order fields (see allowlist below) | v1 |
| Deduplication / merge | Merge duplicate customers (repoint orders, archive loser) | v1 |
| Search & filter | Search orders/customers/drawers; filter by stage, approval state, date | v1 |
| Record detail view | Order page: its drawers, approval states, timeline, linked customer | v1 |
| Audit trail | Append-only `admin_audit` log of every admin edit (who/what/when/before/after) | v1 |
| Notes on records | Free-text notes on order/customer (timestamped, append-only) | v2 |
| Pipeline/kanban board | Group pipeline by stage; aging indicators (approvals waiting > N days) | v2 |
| Exports | CSV export of orders/customers | v2 |
| Metrics | Orders/revenue by month, approval turnaround | v2 |
| Email from record | (T5 notifications cover the transactional side; no CRM mail client) | — |

v1 = T3.5 (this ticket). v2 = T3.6 backlog, pull forward only if needed.

## Sam's feature callouts (2026-07-05) — all v1

1. **Admin tab in the portal nav** when the signed-in account is an admin → links to
   `/admin`. (Header gets an `isAdmin` prop from the server layout; no client-side
   role sniffing.)
2. **Order-list filters for cleanup work:** date range, organization, customer email —
   on top of the stage/approval filters already spec'd. Filters must combine.
3. **Order detail loads drawer media:** photo inline on first click (98/100 drawers
   have jpg/png in the public bucket). "Load 3D model" as an explicit second click —
   measured against the live data (37 drawers have models: `.usdz` + `.ply`):
   - `.usdz` → plain link; Apple QuickLook renders it natively on macOS/iOS (Sam's
     hardware). Zero new dependencies.
   - `.ply` → download link in v1. In-browser rendering needs a three.js-class
     dependency → **v2, gated on dependency sign-off** per the house rules.

## Edit allowlists — the guardrail that keeps this safe

**Order (editable):** `customer_name`, `customer_email`*, `customer_phone`,
`project_name`, `location`, `notes`, `drawer_count`, `total_price` (UI in dollars,
stored **cents** — never forget), customer/org assignment (exists since T3).
*Editing `customer_email` already re-links via the T3 trigger when `customer_id` is null;
when a link exists, the explicit link wins (admin can reassign instead).

**Order (NOT editable):** `drawer_ids` (load-bearing text column tidyCAM reads/writes),
`created_by`, `created_at`, `id`.

**Customer (editable):** `name`, `email` (unique, lowercased), `phone`,
`organization_id`. NOT editable: `auth_user_id` (owned by link-on-login).

**Drawer (editable):** `nickname` only. **Everything else is tidyCAM/tidyDesk's**
(decision 3): `status`, design/scan URLs, dimensions, approval fields (owned by the
approval RPCs). The portal never writes those.

**Deletes:** none in v1. Cleanup = edit + merge + archive flags, not row deletion.
(Hard deletes of PII-bearing history need their own gated decision.)

## Security & reliability requirements (non-negotiable)

1. Every mutation is a `SECURITY DEFINER` RPC with an internal `is_admin()` gate and
   anon EXECUTE revoked — same pattern as T3, which is tested and advisor-clean.
2. **`admin_audit` table** (append-only, immutability triggers like `drawer_event`):
   `id, actor (auth.uid), action, table_name, row_id, before jsonb, after jsonb,
   created_at`. Written inside each admin RPC. RLS: admin-read, no client writes.
   This is what makes "editing history" trustworthy.
3. Validation in the RPCs: email format + uniqueness, price ≥ 0 integer cents,
   name non-empty; merge refuses to merge a customer into itself; all errors surfaced
   as friendly messages in the UI.
4. Same release discipline: migration on a disposable Supabase branch, pgTAP matrix
   (non-admin/anon denied on every new RPC; edits audit-logged; allowlist enforced —
   a test proving the RPCs *cannot* touch `drawer_ids`/`status`), advisors, typecheck +
   build, PR, Sam gates the prod apply.

## Customer-side invariant (unchanged)

Customers keep exactly their current powers: see own/org drawers, approve, request
changes. No T3.5 RPC is callable by non-admins; the customer UI does not change.

## Build plan (small, reviewable steps)

1. **Migration (T3.5a):** `admin_audit` table + immutability + RLS; RPCs:
   `admin_update_order`, `admin_update_customer`, `admin_update_drawer_nickname`,
   `admin_merge_customers`, `admin_create_organization`,
   `admin_assign_customer_organization`, `admin_search` (or per-page query RPCs).
2. **Portal (T3.5b):** admin tab in the nav (admin accounts only); order detail page
   (`/admin/orders/[id]`) with inline edit forms + drawer photos + 3D-model links
   (usdz QuickLook / ply download); customer list + detail/edit (`/admin/customers`);
   merge flow with confirm step; search box + combinable filters (date range,
   organization, customer email, stage, approval state); audit log view
   (`/admin/audit`, read-only).
3. Ship behind the existing `/admin` gate; ROADMAP + this doc updated on completion.

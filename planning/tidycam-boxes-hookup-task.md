# tidyCAM Task — Boxes hookup (Stage 4)

**Owner:** tidyCAM-side agent (repo `tidyCAM`, Flutter/Dart). **Coordinates with:** portal
(`tidytool_webpage/portal`) which owns the shared Supabase DB. **Status:** ready to start once the
portal-side prerequisite below is decided.

## Goal
Let the operator, inside tidyCAM at scan/upload time, group an order's scanned drawers into **boxes**
(containers that duplicate as a unit) and set **copies** — writing that structure into the shared
Supabase DB so the portal quote automatically prices "design once, build many" instead of the
operator re-entering boxes by hand in the admin portal afterward.

## Background — the model (already LIVE in prod)
The portal shipped `Order > Box > Drawer` **and** `Order > Drawer (tray)` on 2026-07-24
(migration `20260724120000_boxes_and_quantities`). It's a **quantity model**: copies share ONE
design record and ONE QR code. `physical_copies = coalesce(box.quantity,1) × drawer.quantity`.
It is **additive and backward-compatible** — every drawer today is effectively a "tray"
(`box_id NULL, quantity 1`), so tidyCAM's current drawer writes already work unchanged.

## Shared DB contract (source of truth — tidyCAM consumes, portal owns migrations)
- **`public.box`**: `id uuid pk`, `order_id uuid not null → order(id) on delete cascade`,
  `label text not null`, `quantity int not null default 1 check (>0)`, `created_at timestamptz`,
  `created_by uuid default auth.uid()`. RLS: **staff SELECT only**; there is intentionally **no
  direct INSERT/UPDATE/DELETE policy** — writes are RPC-only by design.
- **`public.drawer`** gained: `box_id uuid null → box(id) on delete set null`,
  `quantity int not null default 1 check (>0)`.
- **Portal RPCs** (all `SECURITY DEFINER`, **`is_admin()`-gated**, anon EXECUTE revoked):
  `admin_create_box(p_order_id,p_label,p_quantity)→uuid`, `assign_drawer_to_box(p_drawer_id,p_box_id|null)`,
  `admin_set_drawer_quantity(p_drawer_id,p_quantity)`, `admin_update_box(...)`,
  `admin_delete_box(p_box_id)` (reparents its drawers → trays; keeps the drawer rows).
- **Do NOT touch `order.drawer_count` / `order.drawer_ids`** — they keep meaning *design rows* (what
  tidyCAM writes today). Physical-copy math lives ONLY in the quote. Never set `drawer_count` to the
  physical count.

## ✅ Portal-side PREREQUISITE — DONE (2026-07-24, migration `20260724150000_staff_box_management`)
The box-management RPCs were `is_admin()`-gated; they are now **`is_staff()`-gated** (staff OR admin),
so tidyCAM's `staff` operator accounts can call them directly. **No new RPC names** — tidyCAM calls
the SAME functions:
- `admin_create_box(p_order_id, p_label, p_quantity int default 1) → uuid`
- `assign_drawer_to_box(p_drawer_id, p_box_id uuid|null)` (same-order enforced; NULL = make it a tray)
- `admin_set_drawer_quantity(p_drawer_id, p_quantity int)`
- `admin_update_box(p_box_id, p_label text|null, p_quantity int|null)` (NULL = unchanged)
- `admin_delete_box(p_box_id)` (reparents its drawers → trays)

All are `SECURITY DEFINER`, guard `is_staff()` in-body (raise `42501` otherwise), anon EXECUTE revoked,
granted to `authenticated` + `service_role`, and audited. Verified on prod: a staff (non-admin) user
can create/assign/set; a plain user is blocked; anon can't execute. The `admin_` name prefix is now a
slight misnomer (they're staff-callable) but kept so existing portal calls don't break.

**tidyCAM auth requirement:** the operator's Supabase session must hold the `staff` (or `admin`) role
in `public.user_roles`. Grant staff via the portal Admin → Employees screen. If the tidyCAM writer
uses the service-role key instead of a user session, it also satisfies these grants.

## tidyCAM-side work
1. **Scan/order UI:** in the per-order scan session, let the operator define boxes (label + copies)
   and assign scanned drawers to a box, plus set per-drawer copies. Unassigned drawers stay trays.
2. **Write path:** on upload/sync, create the box rows (via the sanctioned staff path above) and set
   each drawer's `box_id` + `quantity`. Keep writing `order.drawer_count` / `order.drawer_ids` exactly
   as today (design rows).
3. **Idempotency / edits:** re-syncing an order must UPDATE existing boxes (match by `box.id` or a
   stable client key) rather than duplicate them; moving a drawer out of a box sets `box_id = NULL`.
4. **QR unchanged:** copies share the design's single QR (`/q/?d={drawer_id}`) — do **not** mint
   per-copy QRs (that's a deliberately deferred, separate "instance model").

## Constraints
- Additive & backward-compatible: an order with no boxes must behave exactly as it does today.
- One drawer row per unique design; copies come from `box.quantity × drawer.quantity`, never by
  inserting duplicate drawer rows.
- `order.drawer_count` stays = number of drawer (design) rows; don't repurpose it.

## Acceptance criteria
- In tidyCAM, an operator can create "Blue box ×2" on an order, drop 3 scanned drawers into it, leave
  1 as a tray, and set one drawer to ×2 copies.
- After sync, the portal's `get_admin_order_detail` shows the boxes + each drawer's `box_id`/`quantity`,
  and a portal quote prices foam per physical copy (`box.qty × drawer.qty`) with design charged once —
  matching what the operator set, with **no manual admin re-entry**.
- Existing boxless orders are unchanged; `drawer_count` / `drawer_ids` semantics intact.

## Open questions for Sam / portal
- Permission model for tidyCAM box writes: staff RPCs vs. RLS INSERT policy? (Portal decides + migrates.)
- Is there a natural place in tidyCAM's scan flow to group drawers, or is this net-new UI?
- Authority if both sides edit a box (portal admin vs tidyCAM): suggest last-write-wins; portal admin
  can always correct.

**Reference:** portal plan `claude/boxes-and-quantities-plan-2026-07-24.md`; project memory
`tidytool-boxes`; migrations in `tidytool_webpage/portal/supabase/migrations/20260724120000_*` and
`..._admin`-side box RPCs.

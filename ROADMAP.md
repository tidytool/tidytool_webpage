# TidyTool Website + Portal Roadmap

**Created:** June 12, 2026 · **Last refreshed:** July 24, 2026

**Direction:** Two pillars. (1) **Lead gen** — the public marketing site (`docs/`) as a credibility
prop for outbound Cache Valley / regional-Utah sales: lean-manufacturer audience first, brand-hedged
pending the rebrand call. (2) **Customer portal** (`portal/`) — the post-sale account hub where
customers approve foam designs (our go-ahead to cut) and track orders, and where staff quote and manage
every order. Separate Next.js + Supabase app; **marketing conversion always takes precedence over portal
features.**

**Guiding constraint (2026-07-24):** the software is now **ahead of the sales motion**. The portal
already does login, design approval, a full admin CRM, notifications, quoting, and box/copy pricing. The
binding business constraint is **sales volume, not features.** So the path forward favors work that either
(a) removes operational friction on real orders, or (b) forces a strategic decision — over net-new portal
surface area. Build the timeline/est-delivery because they cut support load; make the rebrand call; then
let sales throughput pull the next features.

---

## Where things stand — July 24, 2026

**Marketing site (Pillar 1) — credibility core done and live.** Phases 0–1 complete. The conversion
redesign (pain-led hero "Stop losing tools…", proof-first flow, site-wide "Get Started" CTA, `privacy.html`)
is **merged and live** on `thetidytool.com` (GitHub Pages serves `docs/`). What remains here is owner
content and the Google Business Profile.

**Customer portal (Pillar 2) — live and feature-rich** at `app.thetidytool.com` (Vercel). Shipped to prod:

- **Auth + approval:** invite/claim login (magic-link + password), customer dashboard, in-portal design
  **approval** with a per-drawer changelog.
- **Admin CRM:** orders / customers / organizations / employees, search + filter, bulk actions,
  manual create, hard-delete with an append-only audit trail, staff-role management.
- **Notifications:** customer lifecycle emails via Resend (design-ready, approved).
- **Quoting engine:** config-driven pricing ($20/sqft, $40/drawer + $250/order minimums), priced
  travel-based services, internal cost/margin with below-target flagging, QuickBooks-ready breakdown,
  and a quote status workflow.
- **Boxes & drawer quantities:** `Order › Box › Drawer` (+ standalone trays), "design once / build many"
  pricing per physical copy, and automated site-address → round-trip-miles distance lookup.
- **Scan quality:** calibration-accuracy admin dashboard + capture-quality instrumentation (fed by
  tidyCAM scans; populates as new scans arrive).
- **QR drawer pages:** public read-only pages at `/q/?d={drawer_id}` (no schema/tidyCAM change).

**In review right now:** the **order-page UX redesign** (branch `feat/orders-page-redesign`) — the order
shown as nested boxes/trays, a top-of-page Generate-quote modal, and an optional Organize mode. `tsc`
clean; pending Vercel preview + a visual pass, then merge.

---

## Path forward — priority order

Near-term, roughly in order of leverage:

1. **Merge the order-page UX redesign.** In review; ship after the preview build + click-through.
2. **Finish the quoting/boxes prod rollout — ops, ~an afternoon.**
   - Add `GOOGLE_MAPS_API_KEY` + `SHOP_ORIGIN_ADDRESS` to **Vercel** (Prod + Preview) so "Look up distance"
     works live.
   - Confirm the **pricing_config v2** row is the active one in prod (the v2 engine needs the v2 config).
   - Turn on **leaked-password protection** and apply the **Postgres patch** (Supabase dashboard).
   - Delete the remaining `[TEST]` drawer rows.
3. **T3.7 — Estimated delivery date (small, high ROI).** One nullable `order.estimated_delivery` column;
   admin sets/edits it (fits the create/edit forms + the bulkbar); show "Est. delivery" on the customer
   dashboard. Directly reduces "when do I get it?" emails and feeds T4. *Not started (verified — no code).*
4. **T4 — Customer lifecycle timeline ("pizza tracker").** The event backbone (`drawer_event` + approval
   changelog) already exists; the missing piece is the **customer-facing** order-status timeline
   (received → in design → approved → in fabrication → delivered), customer RLS on events, and a
   status-change trigger. This is the portal's biggest remaining customer-facing gap.
5. **Boxes Stage 4 — tidyCAM scan-time grouping (cross-repo).** Let the operator define boxes/copies
   during the scan so structure flows into the quote automatically instead of manual admin re-entry. Task
   doc: `planning/tidycam-boxes-hookup-task.md`; the staff-callable RPCs are already in place. Deferred
   until the tidyCAM-side build is scheduled.
6. **Notification leftovers.** Discord webhook + Vault secret rotation; include est-delivery in the emails;
   the engrave label-entry flow still waits on tidyCAM producing per-tool names.
7. **Reorder + saved designs.** Pillar 2's long-term value; not yet spec'd. Do it once repeat-order volume
   justifies it — not before.

Running in parallel — **owner / strategic:**

- **Google Business Profile** — register under the legal entity + postcard verification
  (`planning/gbp-setup-checklist.md`). ~8-week target; portable through a rename.
- **Rebrand decision — deadline ~September 2026.** The strategic fork: it gates link-building, directory
  citations, paid brand assets, and the Phase 3 SEO content. Every undecided month is unbuilt domain equity.

---

## Phase 0 — Stop the bleeding ✅ COMPLETE

Real Tally form embedded; real email / phone / "Logan, Utah" in footer and title tag.

## Phase 1 — Credibility core ✅ COMPLETE

- ✅ Lean vocabulary site-wide (5S, shadow boards, poka-yoke, audit-ready tool control); ROI "Real Costs"
  framing; segment ordering (Lean → Schools → Aviation).
- ✅ Proof: install gallery, named testimonial (Jeff Waddoups), Bridgerland case study page.
- ✅ Local trust signals ("Designed and cut in Logan, Utah"; localized title tag).
- ✅ **Conversion redesign — MERGED + LIVE** (was PR #5): pain-led hero, proof-first flow
  (pain → proof → process → why-it-works → segments → form), site-wide **"Get Started"** CTA,
  `docs/privacy.html`.
- Still owner-side: make the Tally "How did you hear about us?" question optional; collect 1–2 more
  testimonials; swap in higher-res install/hero photos (current 360×480 is soft).

## Phase 2 — Local visibility, brand-hedged

Hedge rule: build assets that survive a rename; hold anything that compounds under the "TidyTool" name.

- ✅ LocalBusiness JSON-LD on the site; ✅ segment landing pages (`lean-manufacturing.html`,
  `technical-schools.html`) live + in nav + sitemap; ✅ on-page local-intent titles/meta.
- ⬅ **Open (only portable item left): Google Business Profile** — Sam, see `planning/gbp-setup-checklist.md`.
- Deferred until the rebrand call: link building, directory citations, press/PR, paid brand assets.

## Phase 3 — Depth & inbound groundwork (post-rebrand decision)

- 3–5 brand-neutral, buyer-intent resource articles ("5S shadow board guide," "XLPE vs Kaizen foam,"
  "FOD prevention tool control," "tool accountability for trade programs") — the portable SEO assets that
  later support national expansion.
- **Customer-facing** quote-flow upgrade: photo-upload, drawer dimensions, tier selector to cut back-and-forth
  before the scan visit. (Distinct from the internal staff quoting engine, which now exists.)
- Second case study (manufacturer, once one closes).
- Revisit geography: out-of-radius inbound is the signal to start the national-keyword conversation.

## Phase 4 — Customer portal ▶ ACTIVE

Full spec: `planning/FEATURE-profiles.md`; integration architecture: `planning/ARCHITECTURE.md`.

**Shipped to prod:**

- ✅ QR drawer page MVP (`docs/q/`, `docs/drawer.html`) — public read-only, permanent URL contract.
- ✅ Authenticated portal LAUNCHED 2026-07-03 (login, dashboard, in-portal approval).
- ✅ T1 schema baseline · ✅ T2 durable identity (organizations, `customer.auth_user_id`,
  `order.customer_id`, link-on-login) · ✅ T3 portal on durable model + admin view.
- ✅ T3.5 / T3.5b / T3.5c — admin CRM: filterable orders, order detail with media, customers, org tab,
  History (audit), UI overhaul, delete/bulk/manual-create.
- ✅ T3.6 admin invite-to-portal · ✅ T-employees staff-role management (Employees tab, gates the tidyCAD
  work queue).
- ✅ T5 notifications (Resend lifecycle emails).
- ✅ **T3.8 quoting engine — LIVE in prod** (pricing rules, quote schema, admin Quotes section,
  QuickBooks breakdown; whole-dollar rounding dropped so lines reconcile to the cent).
- ✅ **Boxes & drawer quantities Stages 1–3 — LIVE in prod** (`Order › Box › Drawer` + trays, copies-aware
  engine, priced travel services, site address + automated distance lookup, dirty-state box/drawer save,
  quote-drift flag).
- ✅ Calibration-accuracy dashboard + scan capture-quality instrumentation.

**In review / next:**

- ▶ **Order-page UX redesign** — branch `feat/orders-page-redesign`, in review.
- ▶ **Customer dashboard + label-page UX redesign** — branch `feat/portal-ux-redesign`, in review:
  work-queue dashboard (grouped drawer rows, photo thumbnails, one status per drawer), customer
  approval step removed from the portal (label submission = go-ahead; migration
  `20260804120000_label_submit_auto_approval` staged, NOT applied), professional copy pass,
  single-accent pocket outlines + sticky photo on `/labels/[id]`.
- ▶ **T3.7 estimated delivery date** — TODO (see Path Forward #3).
- ▶ **T4 lifecycle + timeline (migration 0005)** — event backbone exists; customer-facing status timeline,
  customer `drawer_event` RLS, and status-change trigger remain (Path Forward #4).
- ▶ **Boxes Stage 4 — tidyCAM scan-time grouping** — deferred, task doc ready (Path Forward #5).
- Notification leftovers: Discord webhook → Vault rotation; engrave label-entry still waits on tidyCAM
  per-tool names.

Explicitly **not** in this phase: drag-and-drop layout editor, customer photo uploads, shop/fleet
inventory (the future paid B2B tier).

---

## Owner Action Items (open)

Human tasks that need Sam directly:

- [ ] **Google Business Profile** — register + postcard verification (`planning/gbp-setup-checklist.md`).
      Target: verified within ~8 weeks.
- [ ] **Rebrand decision — deadline ~September 2026.** Set a calendar reminder. All Phase 2 assets are
      brand-neutral and survive a rename.
- [ ] **Supabase dashboard:** enable leaked-password protection; apply the Postgres patch upgrade
      (`planning/portal-launch-runbook.md`).
- [ ] **Vercel:** add `GOOGLE_MAPS_API_KEY` + `SHOP_ORIGIN_ADDRESS` (Prod + Preview) so distance lookup
      works in production.
- [ ] **Clean-up:** delete the remaining `[TEST]` drawer rows (admin delete UI).
- [x] ✅ Testimonial + case study live (more testimonials still nice-to-have).
- [x] ✅ Supabase database hardening (2026-07-03) + ongoing security-guard migrations.

---

## What we are deliberately NOT doing

- National SEO competition with FoamFit / Kaizen Foam / Shadow Foam — premature.
- E-commerce / self-serve ordering — the product needs a scan/design step; a form + consult is correct.
- Blog volume for its own sake — proof pages beat posts at this stage.
- Backlink campaigns — frozen until the brand name is settled.

## Success measures

The original June 90-day measures (form live, proof section, GBP) are met **except GBP**. Current-stage
measures:

- Every new order is **quoted through the portal** shortly after the scan (quoting engine is live —
  make it the default motion, not a spreadsheet).
- Customers can self-serve **"where's my order?"** once T4 + est-delivery ship (target: fewer status emails).
- **GBP verified and live.**
- **Rebrand decision made by September 2026.**
- Qualitative check still holds: does a CI engineer visiting the site see their own vocabulary?

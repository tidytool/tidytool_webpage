# TidyTool Website + Portal Roadmap

**Date:** June 12, 2026 (updated June 28, 2026)
**Direction:** Two pillars. (1) **Lead gen** — a credibility prop for outbound Cache Valley sales: lean-manufacturer audience first, local/regional Utah SEO, brand-hedged (rebrand undecided). (2) **Customer portal** — the post-sale account hub where customers approve designs and track orders (Phase 4, now active).

Pillar 1's job: when a CI engineer at Autoliv or Thermo Fisher gets your email or visits after a noon drop-in, the marketing site must confirm you're credible in their world within 30 seconds. It is not a traffic engine yet.

Pillar 2's job: once someone buys, give them one signed-in place to review and approve their foam layouts (our go-ahead to cut), track order status, and — later — reorder and manage saved designs. Built as a separate Next.js + Supabase app in `portal/`; conversion on the marketing site always takes precedence.

---

## Phase 0 — Stop the bleeding ✅ COMPLETE

1. **Replace the Tally form placeholder.** ✅ Real Tally form (`LZoGyG`) embedded and working.
2. **Fix footer/contact basics.** ✅ Real email (`sam@thetidytool.com`), phone (`(435) 999-4824`), and "Logan, Utah" in footer and title tag.

## Phase 1 — Credibility core ✅ COMPLETE

**Reframe the messaging for CI engineers.** ✅ Complete.

- ✅ Hero and site-wide lean vocabulary: 5S, shadow boards, visual management, poka-yoke, audit-ready tool control. FAA/OSHA stats in aviation segment card.
- ✅ ROI framing: tool-search time, audit prep time, replacement cost in "Real Costs" section.
- ✅ Lean Manufacturing block added and leading; Schools second; Aviation third.

**Publish proof.** ✅ Complete.

- ✅ Install photo gallery (3 real install photos; before/after pending owner follow-up).
- ✅ Testimonial card with owner TODO prompts placed above case study teaser.
- ✅ Case study page (`case-study-technical-college.html`) scaffolded with owner TODO prompts for all real content.

**Local trust signals.** ✅ Complete.

- ✅ "Designed and cut in Logan, Utah" in footer and CTA section.
- ✅ Localized title tag: "Custom Foam Tool Organizers for Lean Manufacturing | TidyTool — Logan, Utah."

**Conversion redesign (2026-07-05, branch `feature/landing-conversion-redesign`, awaiting Sam's preview approval).**

- Pain-led hero ("Stop losing tools. Stop losing time.") with proof photo; social proof (testimonial + gallery + case study) moved directly under the hero.
- Flow now: pain → proof → process → why-it-works (Real Costs / Lean / Why / Materials merged) → segments → form. Stat strip and mid-page CTA band cut.
- CTA renamed site-wide: "Get a Fast Quote"/"New Customer" → **"Get Started"** (the conversion is scheduling the consult call).
- Added `docs/privacy.html` + footer link (form collects lead data; no legal page existed).
- Spec was `planning/FEATURE-landing-conversion-redesign.md` (shipped PR #5; pruned 2026-07-07, see git history). Still owner-side: Tally form — make "How did you hear about us?" optional; collect 1–2 more testimonials; higher-res install photos (current 360×480 is soft as a hero image).

## Phase 2 — Local visibility, brand-hedged (weeks 5–8)

Hedge rule: build assets that survive a rename. Hold anything that compounds under the "TidyTool" name.

**Do now (portable):**

- Google Business Profile under the legal business entity, category "Manufacturer," Logan UT service area. GBP transfers through a rename far better than backlinks do. ⬅ **only open item — Sam, see `planning/gbp-setup-checklist.md`**
- ✅ LocalBusiness schema markup on the site (JSON-LD in `docs/index.html`; live since 2026-06-12).
- ✅ Segment landing pages: `docs/lean-manufacturing.html` + `docs/technical-schools.html` — live, linked in nav, in sitemap (verified 2026-07-09).
- ✅ On-page SEO for local-intent terms — localized titles/meta on homepage and both landing pages.

**Defer until rebrand decision:**

- Link building, directory citations, press/PR.
- Paid brand assets (signage, vehicle, printed collateral beyond what sales needs).
- Set a decision deadline: **rebrand call by ~September 2026.** Every month undecided is a month of unbuilt domain equity.

## Phase 3 — Depth and inbound groundwork (months 3–6, post-rebrand decision)

- 3–5 brand-neutral resource articles targeting buyer-intent searches: "5S shadow board guide," "XLPE vs Kaizen foam," "FOD prevention tool control," "tool accountability for trade programs." These are the portable SEO assets that later support a national expansion.
- Quote flow upgrade: photo-upload field, drawer dimensions, tier selector — reduce back-and-forth before the scan visit.
- Second case study (manufacturer, once one closes).
- Revisit geography: if inbound quote requests arrive from outside delivery radius, that's the signal to start the national keyword conversation.

## Phase 4 — Customer portal: profiles, QR drawer pages, design approval (post-Phase 1, parallel-friendly)

Full spec: `planning/FEATURE-profiles.md`. Free-included with every order — the engraved QR is a referral channel, not a revenue line.

- ✅ **QR drawer page MVP (spec Phase C1) — shipped 2026-06-24, awaiting deploy.** `docs/q/index.html` (permanent redirect layer) + `docs/drawer.html` (public read-only page: photo, nickname, size/status chips, "Get a Fast Quote" CTA). Reads the live Supabase `drawer` table by `id` via plain `fetch` + the anon key — **no `supabase-js`, no framework, no build step.** Mobile-first.
- **Scope reconciled with the real backend.** tidyCAM (the mobile app) already writes orders + drawers + scans to Supabase, so the spec's ingestion/auth-provisioning half is not ours to build. The real `drawer` table has no per-tool item list and no engrave labels yet, so the **approval + label-entry flow (spec Phase B) is deferred** until tidyCAM produces tool names.
- **QR URL contract (permanent):** engrave `https://www.thetidytool.com/q/?d={drawer_id}`. Uses the drawer's existing `id` (uuid) as the token — no schema change, no tidyCAM change. Domain decided: stay on `thetidytool.com` through any migration/rebrand.
- ✅ **Authenticated portal LAUNCHED 2026-07-03** at `app.thetidytool.com` (Vercel, `portal/`): email+password login with magic-link first-time/recovery setup, dashboard of the customer's drawers, in-portal approval screen. `customer-login.html` now links to the live portal. (Nav rename to "tidytool Portal" is PAUSED per Sam 2026-07-03 — reverted to "Customer Login" for now.) Remaining launch hygiene (see `planning/portal-launch-runbook.md`): ✅ custom SMTP + templates (live 2026-07-05 via Resend); signups stay **enabled** by decision 2026-07-05 (invite-only enforced by the tidyCAM approval-gate RLS instead — see `planning/TIDYCAM-launch-coordination.md`); still open: leaked-password protection, delete `[TEST]` drawers.
- **Active: the integration architecture** (`planning/ARCHITECTURE.md`, direction approved 2026-07-03). Sequence: schema baseline → durable identity → portal on durable model + admin → **admin CRM (T3.5, HIGH)** → lifecycle timeline → notifications (needs SMTP).
  - ✅ **T1 — Schema baseline (2026-07-03):** all prod migration-history entries materialized byte-exact into `portal/supabase/migrations/` (md5-verified); fresh-branch fingerprint == prod. Storage policies captured in `20260703220000`. Applied to prod. See `portal/supabase/migrations/README.md`.
  - ✅ **T2 — Durable identity, migration 0004 (applied to prod 2026-07-03):** `organization`, `customer.auth_user_id`/`organization_id`, `order.customer_id`, stale customer rows archived+purged, 27 customers backfilled / 29 orders linked / 28 orphans, link-on-login triggers, own-row/whole-org/admin RLS. 22 pgTAP checks green on branch.
  - ✅ **T3 — Portal on the durable model + admin view (DB applied to prod 2026-07-05; PR merge → Vercel deploy pending):** order auto-link trigger (backfill is now continuous; email bridge removed from `get_my_drawers` v2, whole-org visibility), `'delivered'` event type, six admin RPCs, `/admin` page (pipeline, orphan-order mapping tool, mark delivered). 28 pgTAP checks green.
  - ▶ **T3.5 — Admin CRM & order tracking (HIGH PRIORITY, active):** `/admin` becomes the primary order-management tool — edit orders/customers (strict allowlists; `drawer_ids`, `drawer_status`, design fields stay tidyCAM/tidyDesk's), customer merge + org management, search/filter, order detail view, append-only `admin_audit` trail. Spec: `planning/FEATURE-admin-crm.md`. Sam's driver: clean up historical records and start tracking everything in one place ASAP.
  - ✅ **T3.5b — Admin UI overhaul + delete/bulk/create (DB applied to prod 2026-07-05):** full visual redesign of `/admin` (design-system pass in `globals.css`: unified control heights, segmented tab nav with active state, grid tables, removable applied-filter chips, styled date filters, wide admin layout). New capability: hard-delete orders (cascades drawers/events, before-image audit-logged, typed-DELETE confirm), multi-select unassigned orders for bulk assign/delete, delete guarded customers/orgs, org rename/list (incl. empty orgs), manual order creation, new-customer form. Migrations `20260707000000` + `20260707000001` (also fixed: customers RPC now returns `phone` — the edit field was always blank). Sam approved delete semantics + prod apply in-session 2026-07-05.
  - ✅ **T3.5c — Bulk everywhere + tab restructure (DB applied to prod 2026-07-05):** multi-select with bulk actions on every admin list — Orders (bulk assign/delete), Pipeline drawers (bulk mark-delivered w/ shared note, bulk hard-delete for test rows, typed-DELETE), Customers (bulk delete), Organizations (bulk delete empty ones). Customer delete relaxed per Sam: unlinks their orders (become unassigned) instead of blocking; portal-login customers stay protected. Organizations moved to their own tab; "Audit" renamed "History" (route `/admin/history`). Migration `20260707000002`.
  - **T3.7 — Estimated delivery date (order-level, admin-set) — TODO, added 2026-07-07:** give customers a "when do I get it" answer in the portal. Data model decided: one nullable `estimated_delivery date` column on `order`, set/edited by admin (no per-drawer dates for now). Interfaces needed:
    - **DB migration** (prod schema change — Sam review before apply): add `order.estimated_delivery`; add it to the admin edit-order allowlist and `admin_create_order`; return it from the admin orders RPC and the customer read path (`get_my_drawers` v3 or an order RPC).
    - **Admin UI (`/admin`):** date field on the order create/edit forms and order detail view; optional bulk-set on the Orders tab (fits the existing bulkbar pattern).
    - **Portal UI:** show "Est. delivery" on the customer's dashboard order/drawer cards; feeds the T4 pizza-tracker timeline once that ships.
    - **Deferred follow-ups:** include the date in the design-ready/approved notification emails; auto-suggest from historical lead times.
  - ✅ **T3.8 — Quoting engine (built 2026-07-24; DB migration STAGED, awaiting Sam's review before prod apply):** config-driven pricing engine (`portal/src/lib/pricing/`: normalizer for both dimensions-JSON generations → `$20/sqft × thickness multiplier`, $40/drawer + $250/order minimums as a visible "Minimum Order Adjustment" line, included service lines) + internal cost model (mileage $0.70/rt-mi, $20/hr driving/scanning/install, 5 min/sqft scanning, 2 trips) with `estimated_cost / sell_price / gross_profit / gross_margin` stored per quote and **below-60%-target flagging (never auto-repriced)**. Migration `20260724000000_quoting_engine.sql`: `pricing_config` (versioned rate cards, one active) + `quote` + `quote_line_item`, staff-only RLS, integrity-checked `save_quote` / audited `set_quote_status` (accept → copies total to `order.total_price`) / `get_quotes_for_order`. Admin order page grew a Quotes section (generate/review/status). 19 unit tests green (`npm run test:pricing`); round-trip verified on a disposable branch (deleted). All money integer cents; the quote total is the exact line sum, to the cent (whole-dollar rounding dropped per Sam 2026-07-24 so the line column reconciles).
  - **T4 — Lifecycle + timeline (migration 0005):** `drawer_event` RLS for customers, status-change trigger → events, customer-state view, portal "pizza tracker" timeline.
  - ✅ **T5 — Notifications (LIVE 2026-07-05):** custom SMTP via Resend + `notify` edge function + migration `20260708000000` applied to prod; design-ready and approved customer emails smoke-tested (see `planning/smtp-notifications-runbook.md`). Still open from the original scope: Discord webhook → Vault rotation. Migrations live in `portal/supabase/migrations/` (this repo owns the DB; tidyCAM consumes). The old "vanilla `account.html`" plan is retired — the portal IS the account hub. Label entry (spec Phase B) still waits on tidyCAM tool names.
- Explicitly NOT in this phase: drag-and-drop layout editor, customer photo uploads, shop/fleet inventory (the future paid B2B tier).

---

## Owner Action Items (open)

These are human tasks that require Sam's direct involvement. They are tracked here so they don't fall through the cracks.

- [ ] **GBP setup:** Follow `planning/gbp-setup-checklist.md` — register under your legal entity name, complete postcard verification, upload install photos. Target: verified and live within 8 weeks.
- [x] ✅ **Testimonial — done.** Named Jeff Waddoups quote live on the homepage; Bridgerland case study live (`case-study-technical-college.html`). Still nice-to-have: 1–2 additional testimonials (tracked in `planning/STATUS.md`).
- [ ] **Rebrand decision deadline:** September 2026. Every month undecided is a month of unbuilt domain equity. Set a calendar reminder. All current Phase 2 assets (GBP, landing pages, schema) are brand-neutral and survive a rename.
- [x] ✅ **Supabase database hardening — done 2026-07-03.** Anon blanket reads on `drawer`/`employee` closed (`0002_harden_anon_reads.sql`; public QR page uses `get_public_drawer()` RPC); round 2 (`0003_harden_round2.sql`) revoked anon `is_admin()`, dropped duplicate policies, closed whole-bucket listing. All verified against prod. Still open elsewhere: leaked-password protection (Sam, dashboard) and Postgres patch upgrade — tracked in `planning/portal-launch-runbook.md`.

---

## What we are deliberately NOT doing

- National SEO competition with FoamFit/Kaizen Foam/Shadow Foam — premature.
- E-commerce/self-serve ordering — your product requires a scan/design step; a form is correct.
- Blog volume for its own sake — proof pages beat posts at this stage.
- Backlink campaigns — frozen until the brand name is settled.

## Success measures (90 days)

- Quote form live and submitting (week 1).
- Proof section live: gallery + named testimonial + 1 case study (week 4).
- GBP verified and live (week 8).
- Qualitative check: does a CI engineer visiting the site see their own vocabulary? Test it on one friendly prospect.

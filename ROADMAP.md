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

## Phase 2 — Local visibility, brand-hedged (weeks 5–8)

Hedge rule: build assets that survive a rename. Hold anything that compounds under the "TidyTool" name.

**Do now (portable):**

- Google Business Profile under the legal business entity, category "Manufacturer," Logan UT service area. GBP transfers through a rename far better than backlinks do.
- LocalBusiness schema markup on the site.
- Segment landing pages: `/lean-manufacturing` and `/schools` — content is brand-neutral and moves with you.
- On-page SEO for local-intent terms: "custom foam tool organizers Utah," "shadow board foam inserts," "5S tool control foam."

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
- ✅ **Authenticated portal LAUNCHED 2026-07-03** at `app.thetidytool.com` (Vercel, `portal/`): email+password login with magic-link first-time/recovery setup, dashboard of the customer's drawers, in-portal approval screen. `customer-login.html` now links to the live portal. (Nav rename to "tidytool Portal" is PAUSED per Sam 2026-07-03 — reverted to "Customer Login" for now.) Remaining launch hygiene (see `planning/portal-launch-runbook.md`): custom SMTP + token_hash email templates, disable open signups, leaked-password protection, delete `[TEST]` drawers.
- **Next: the integration architecture** (`planning/ARCHITECTURE.md`, direction approved 2026-07-03). Sequence: schema baseline → durable customer/org identity model + backfill (portal-first; tidyCAM intake linking follows) → customer lifecycle + `drawer_event` timeline → notifications (needs SMTP) → admin pipeline view. ✅ **Schema baseline (T1) done 2026-07-03:** all 10 prod migration-history entries materialized byte-exact into `portal/supabase/migrations/` (md5-verified against `supabase_migrations.schema_migrations`); fresh-branch fingerprint == prod fingerprint (public schema exact; the 8 pre-baseline storage policies captured in `20260703220000_baseline_storage_policies.sql`, branch-tested, **prod apply awaiting Sam**). See `portal/supabase/migrations/README.md`. Migrations live in `portal/supabase/migrations/` (this repo owns the DB; tidyCAM consumes). The old "vanilla `account.html`" plan is retired — the portal IS the account hub. Label entry (spec Phase B) still waits on tidyCAM tool names.
- Explicitly NOT in this phase: drag-and-drop layout editor, customer photo uploads, shop/fleet inventory (the future paid B2B tier).

---

## Owner Action Items (open)

These are human tasks that require Sam's direct involvement. They are tracked here so they don't fall through the cracks.

- [ ] **GBP setup:** Follow `planning/gbp-setup-checklist.md` — register under your legal entity name, complete postcard verification, upload install photos. Target: verified and live within 8 weeks.
- [ ] **Testimonial:** Fill in the `[TODO]` placeholders on the homepage proof section and the case study page (`case-study-technical-college.html`). Get written permission from your contact before publishing their name and title.
- [ ] **Rebrand decision deadline:** September 2026. Every month undecided is a month of unbuilt domain equity. Set a calendar reminder. All current Phase 2 assets (GBP, landing pages, schema) are brand-neutral and survive a rename.
- [x] **Supabase database hardening (security debt, deferred 2026-06-24).** _Done 2026-07-03: `0002_harden_anon_reads.sql` fully applied to prod. Verified: anon reads 0 rows from `drawer`/`employee`; `get_public_drawer(id)` still returns the public-safe row for a known id; deployed `docs/` pages only use RPCs. Round 2 applied 2026-07-03 (`portal/supabase/migrations/0003_harden_round2.sql`): `is_admin()` anon-revoked, duplicate `drawer` INSERT/UPDATE policies dropped, whole-bucket listing of `drawer-assets` closed. Still open: leaked-password protection (Sam, dashboard), Postgres patch upgrade._ Original scope:
  - `drawer` table has a `"Enable read access for all users"` policy (anon SELECT, `qual = true`) — the anon key can read **every column of every drawer**, including internal fields (`created_by`, `order_id`, `dxf_url`, `point_cloud_url`). Replace with a `SECURITY DEFINER` function `get_public_drawer(id)` returning only public-safe fields (`nickname`, `photo_url`, `dimensions`, `status`), then drop the blanket policy. (Won't break tidyCAM — the app reads as the authenticated owner.)
  - `employee` table has the same `"Enable read access for all users"` policy — anon can read employee names, phones, catchphrases. Remove/restrict; unrelated to the QR feature but a live PII exposure.
  - Re-verify after changes: anon can still read a drawer by `id`, but cannot list all drawers, read internal columns, or read the `employee`/`order`/`customer` tables.

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

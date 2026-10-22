# Architecture review — tidytool_webpage, 2026-09-10

**Reviewed:** `main` @ `5ec8ec4` (after PR #34). **Diagram:** `architecture-diagram.md`.
**Method:** four independent read-throughs (portal app layer; portal lib/config/edge function;
database migrations + RLS + RPC consumers; marketing site + repo hygiene), then every
high/medium claim re-verified at source. Mechanical checks: `tsc --noEmit` (clean),
`knip` (5 unused exports, matching the manual findings), `npm run test:pricing` (36/36),
mermaid-cli render of every diagram, a link/anchor crawl of `docs/` (0 broken), and live
read-only checks against prod: the migration history table (54 rows; three with NULL
statements), the Supabase security advisor (12 anon-executable DEFINER functions — 4 are the
intended capability-link RPCs, 8 are the leak described in D-6), `pg_indexes`, row counts.

**Follow-ups:** PR A `chore/architecture-review` (safe hygiene + this document, mergeable
without a gate under CLAUDE.md §4) and PR B `feat/architecture-hardening` (draft, stacked on A;
auth/mutation changes plus proposed migrations under `planning/proposed-migrations/`, each
needing Sam/Shem sign-off).

IDs: **P** portal app · **L** portal lib/config · **D** database · **M** marketing/docs site ·
**R** repo & documentation. Status: ✅ fixed in PR A · 🅱 in PR B · 🔶 decision needed ·
📋 backlog.

---

## 1. Executive summary

The system is in better shape than its own documentation says. The security posture is
sound in the places that matter: every table has RLS, every mutating RPC re-checks
`is_admin()`/`is_staff()` in SQL, the service-role client is unreachable from browser code,
the middleware uses `getClaims()` rather than trusting sessions, and the four anonymous RPCs
are deliberate capability links keyed on unguessable drawer UUIDs. The status backbone
(`20260727100000`) is a well-designed, evented state machine with idempotency keys,
correction semantics and a branch test suite. The pricing engine is pure, integer-cents and
unit-tested. The marketing site has zero broken links, alt text everywhere, and a single
well-protected conversion path.

What is wrong is mostly **drift** — between code and docs, between two approval flows, between
hand-written types and SQL, between the UI's idea of "admin only" and the RPCs' idea of
"staff" — plus a handful of genuine defects that a careful reader finds once the drift is
cleared away:

| # | Finding | Sev | Status |
|---|---|---|---|
| P-1 | Quote pricing ignores a failed `box` query → silently under-prices boxed drawers | high | 🅱 |
| P-2 | Order/drawer state, quotes and boxes are admin-only in the UI but staff-callable via server actions and RPCs | high | 🅱 + 🔶 |
| P-3 | `lookupOrderDistanceAction` bills Google before any role check — any signed-in customer can burn quota | high | 🅱 |
| P-4 | Eight admin actions `throw` with no error boundary → generic crash page on a DB guard message | high | ✅ boundary; 📋 pattern |
| P-5 | Open redirect via `?next=` in `/auth/confirm` | medium | 🅱 |
| D-1 | Migration directory cannot be replayed in version order; the documented diagnosis and fix are wrong | high | ✅ docs; 🔶 repair |
| D-2 | `link_customer_on_auth` grants portal visibility at sign-up with no email-confirmation check | high | 🅱 migration |
| D-6 | Eight staff RPCs became anon-executable when `20260812210000` dropped+recreated them (advisor confirms) | medium | 🅱 migration |
| D-3 / D-5 | `order.computed_status` not recomputed on drawer delete; recompute has a lost-update race | medium | 🅱 migration |
| D-11 / D-12 | Anonymous RPCs return the whole `dimensions` JSON (staff names, calibration internals); `employee` table readable by every signed-in user | medium | 🅱 migration |
| M-1 | Two live customer-approval flows give different instructions (email → `docs/approve`; portal → "labels are your go-ahead") | high | 🔶 |
| R-2 | CLAUDE.md, both READMEs, ROADMAP and four planning docs described June/July state | medium | ✅ |

Dead code found and removed in PR A: 5 unused exports, 2 stale "apply the migration"
branches, 9 dead CSS rules, an unreferenced 112 KB image, and two compiled `.pyc` files (one
whose source no longer exists). Still-dead SQL objects are listed in §5 for a gated cleanup.

---

## 2. The system in one paragraph

One repo, two deployables, one Supabase project. `docs/` is a plain-HTML brochure on GitHub
Pages whose only job is to route prospects into a Tally form; it also hosts three
capability-link pages (`/approve`, `/q`, `drawer.html`) that call four anonymous RPCs with the
publishable key. `portal/` is a Next.js 15 App Router app on Vercel: customers see an order
tracker and enter tool-label text (which doubles as design approval); staff and admins run a
CRM, quoting engine, box/quantity management, a status pipeline and employee management,
all through ~70 `SECURITY DEFINER` RPCs. Two external apps (tidyCAM on iPad, tidyCAD on
desktop) write into the same database through RLS and a contract set of RPCs. Postgres
triggers drive a stored-but-derived order status and fire `pg_net` webhooks to a single edge
function that sends Resend emails; Discord gets approval pings straight from SQL. Migrations
are applied by `tools/db_apply.py` and mirrored in the repo 1:1 by version+name.

---

## 3. Component classification

### 3.1 Modular (clean seams, replaceable, tested or testable)

| Component | Why it's modular | Watch-outs |
|---|---|---|
| `portal/src/lib/pricing/*` | Pure functions, integer cents, config-driven, 36 tests; QuickBooks export is a projection | Validator (`parsePricingConfig`) doesn't cover every field the engine dereferences (L-2); upgrade basis ambiguity (L-6) |
| Status backbone (`status_def`, `status_transition`, `status_event`, `set_*` RPCs) | Config tables + single event writer + derivation function; branch test suite | Direct writes bypass it (D-4); no DELETE recompute (D-3) |
| `Modal`, `ConfirmButton` | Native `<dialog>`/`confirm`, no deps | `Modal` exposes no controlled `open`, so two consumers re-implement it (P-19) |
| `lib/supabase/*` client factories | One factory per execution context; service role only via dynamic import in `"use server"` | Env vars read with `!` (L-10) |
| `docs/q/` + `drawer.html` | Permanent URL contract, no build, no framework | Shows legacy `status`, not `stage` (D-8/M-4) |
| Edge function `notify` | Stateless, secret-gated, one job | Prod URL hard-coded in SQL helpers; `verify_jwt=false` not captured in repo (L-3) |

### 3.2 Interconnected (coupling that must be managed deliberately)

| Coupling | Where | Consequence |
|---|---|---|
| Hand-written `types.ts` ↔ 54 migrations | `lib/types.ts` header says "keep in sync" — that is the whole mechanism | Already drifted (`DrawerEvent.event_type`, L-1); every new RPC column is a silent runtime mismatch until someone notices |
| `admin/actions.ts` (698 lines, 32 exports) ↔ 9 pages, 12 components | One file spans CRM, orders, drawers, roles, auth-user management, state | Four different form-feedback contracts (P-15); reviewers can't reason about one domain at a time |
| `drawer.status` (legacy enum) ↔ `drawer.stage` | Two-way partial mirror in `drawer_stage_bridge` | Guaranteed divergence for five stages (D-8); legacy advance can skip the approval gate (D-4) |
| `order.customer_email` ↔ `customer.email` ↔ `auth.users.email` | Three lower-cased email joins at link time | `admin_update_order` edits the text field without re-linking (D-9); sign-up links before confirmation (D-2) |
| `docs/approve` ↔ `notify` email ↔ `portal /labels` | Two approval entry points converge on the same columns | Product story diverges (M-1) |
| tidyCAM / tidyCAD ↔ RPC signatures, `drawer_ids` text, `total_price` cents, `qr_url` | Cross-repo contracts documented only in migration headers | Listed in `architecture-diagram.md` §6; there is no shared contract package |
| Vercel previews ↔ Supabase `dev` branch; MCP applies ↔ `db_apply.py` | Two apply paths, two databases | Prod migrations applied via MCP don't reach `dev` unless mirrored by hand (D-16) |

### 3.3 Orphaned (reachable by nothing, or by nothing that should still exist)

| Item | Evidence | Disposition |
|---|---|---|
| `portal/src/app/approve/[id]` + `ApprovalForm` + `History` + `formatDimensions` | No inbound link in `portal/src`; ROADMAP says the in-portal approval step was removed (PR #27) | 🅱 deletion commit (drop the commit if you want to keep it) — P-6 |
| `setCustomerOrgAction`, `assignDrawerToBoxAction`, `setDrawerQuantityAction`, `createQuoteAction`, `getUserEmail` | knip + grep: zero references; exported server actions are live HTTP endpoints | ✅ removed — P-21 |
| SQL: `set_order_override`, `set_delivery_schedule`, `set_capture_quality` + `drawer.capture_quality*` + view `order_capture_quality` | No caller in portal/docs/tools; not named as a tidyCAM/tidyCAD surface | 🔶 confirm with tidyCAD, then drop — D-18 |
| SQL: `employee` (1 row), `drawer_backup_2026_05_02` (96 rows), `_archive_customer_2026_07_03` (20 rows) | Referenced by nothing; advisor flags RLS-without-policies on the two backups | 🅱 employee policy; 🔶 drop backups — D-12, D-18 |
| `docs/cody.html`, `docs/tilly.html` | Reachable only via zero-affordance anchors on the homepage footer | 🔶 — M-6 |
| `docs/approve/sample-preview.png`, `docs/images/logos/Icon-App-1024x1024@1x.png` | Never referenced by any tracked file | ✅ PNG removed; 🔶 icon → favicon or delete — M-7 |
| `tools/__pycache__/*.pyc` (incl. `make_preview`, whose `.py` was deleted 2026-06-28) | Compiled artefacts tracked in git | ✅ untracked + ignored — R-1 |
| `planning/STATUS.md`, `planning/pm-agent.md`, `memory/` | PM agent hasn't run since 2026-07-12; STATUS contradicts shipped work | 🔶 — R-3 |
| `planning/FEATURE-*.md`, `label-tool-prototype.html`, `employees-tab-eval.md`, `customer-interview-form.pdf`, `prompts/phase-4-*` | Specs for shipped features | 🔶 archive — R-4 |
| CSS: `.card--danger`, `.qv__drawer`, `.lbl-banner` (portal); `.nav-phone`, `.form-placeholder`, `.cost-grid`, `.cost .big`, `.grid--5`, `.center` (docs) | No matching class in any TSX/HTML | ✅ removed — P-28, M-8 |

---

## 4. Findings register

Severity: blocker · high · medium · low · nit. Risk class per CLAUDE.md §4: LOW = no gate;
HIGH = Sam/Shem sign-off (auth, mutation semantics, RLS, migrations, conversion path).

### 4.1 Portal — app layer (`src/app`, `src/components`)

| ID | Sev | Risk | Finding (file:line) | Fix | Status |
|---|---|---|---|---|---|
| P-1 | high | HIGH | `quote-actions.ts:132` discards the `box` query error; on failure every boxed drawer prices as 1 copy | Check `boxesError`, return `{ok:false}` like the drawer query two lines above | 🅱 |
| P-2 | high | HIGH | `orders/[id]/page.tsx:161-233` hides state/quote/box controls behind `isAdmin`, but `setOrderStateAction`, `setDrawerStateAction`, `quoteFormAction`, `setQuoteStatusAction`, `create/update/deleteBoxAction`, `updateDrawerPlacementAction` have no role check and their RPCs are `is_staff()` | PR B adds an app-level `requireAdmin` to match the UI; **decide** whether staff should have these (then drop the UI gate instead) and, if admin-only is the intent, tighten the RPCs in a migration | 🅱 + 🔶 |
| P-3 | high | HIGH | `site-actions.ts:44-51` calls `lookupRoundTripMiles` (billed) before `admin_set_order_site` rejects non-admins; any authenticated user can invoke it | Role check first; `AbortSignal.timeout(10s)` on the fetch | 🅱 |
| P-4 | high | LOW | `actions.ts:23,39,45,80,95,108,131,145,622` `throw` on RPC error; no `error.tsx` existed → Next's generic error screen for messages like "customer has orders" | ✅ `admin/error.tsx` boundary added. 📋 Convert the nine `throw` sites to the `redirect(?error=)` form their siblings use | ✅ / 📋 |
| P-5 | medium | HIGH | `auth/confirm/route.ts:21,32,37` — `next` is unvalidated; `new URL("https://evil", origin)` resolves off-site | Accept only `/`-prefixed, non-`//` paths | 🅱 |
| P-6 | medium | LOW* | `/approve/[id]` is unreachable (no inbound link), duplicates `docs/approve/`, and its History is always empty for customers (`get_drawer_changelog` guard is `created_by = auth.uid()`, D-13) | Delete route + `ApprovalForm` + `History` + `formatDimensions`, fix `not-found.tsx` copy — *product decision, so it's an isolated commit in PR B | 🅱 + 🔶 |
| P-7 | medium | HIGH | Non-atomic multi-RPC actions: cancel cascade is one `set_drawer_state` per drawer (`actions.ts:651-662`), `updateDrawerPlacementAction` is three RPCs, `createCustomerAndAssignAction` two | One transactional RPC each (`set_order_state(..., p_cascade)`, `admin_set_drawer_placement`) | 📋 (migration) |
| P-8 | medium | LOW | Errors dropped → silently empty UI: `page.tsx:242` (label status → "Labels needed" CTA vanishes), `admin/page.tsx:36-42`, `customers/page.tsx:19`, `orders/[id]/page.tsx:37,53`, `orders/page.tsx:37` | Surface `error.message` in the existing `banner--err` pattern | ✅ dashboard `get_my_drawers`; 📋 rest |
| P-9 | medium | HIGH | `createPortalLoginWithPassword` (`actions.ts:413`) and `setEmployeePassword` (`:536`) are byte-identical; both `listUsers({perPage:1000})` + linear scan; both can reset any existing user's password by email. Two admin guards: private `requireAdmin()` in actions.ts vs `requireAdminPage()` in lib | PR B moves the guard to `lib/require-admin.ts` (needed by P-2/P-3). 📋 extract `upsertPasswordLogin`, refuse resets for role-holding accounts from the Customers surface | 🅱 / 📋 |
| P-10 | medium | LOW | Access denied detected by regex on error text (`queue:30`, `employees:20`, `accuracy:22`); `employees` is the only admin tab without `requireAdminPage()`; `accuracy` demands admin though its RPCs are staff | PR B: `requireAdminPage()` on employees. 📋 use `error.code === "42501"`; decide staff visibility of Accuracy and align `AdminTabs` | 🅱 / 📋 |
| P-11 | medium | LOW | `QuotesSection.tsx:94` `banner--warn` undefined; `--c-warn`, `--c-brand`, `--c-muted` don't exist so hard-coded fallbacks always applied | ✅ tokens + class added, components use real tokens | ✅ |
| P-12 | medium | LOW | Hex palettes duplicated as JS constants in `StatusPipeline.tsx:19-22`, `CalibrationAccuracy.tsx:27-33`, `LabelEditor.tsx` (25 literals) — violates DoD "no hard-coded one-off colors" | Use `var(--c-*)` strings (SVG accepts them, `LabelEditor.tsx:333` proves it) | 📋 |
| P-13 | medium | LOW | Bulk-select scaffolding copied 5× (`OrdersTable`, `UnassignedOrders`, `PipelineList`, `CustomersList`, `OrganizationsList`) | `useSelection()` hook + `<BulkBar>` (~100 lines removed) | 📋 |
| P-14 | medium | LOW | `is_admin`/`is_staff` RPCs re-run in layout and again in 4 pages | `React.cache()`-wrapped `getRole()` in `lib/supabase/auth.ts` | 📋 |
| P-15 | medium | LOW | Four form-feedback contracts (throw / redirect `?error=` / return `{error}` / `useActionState`); `?error=` survives reload and back-nav | Write the rule down; migrate the `throw` sites | 📋 |
| P-16 | medium | LOW | Keyboard-inaccessible click rows (`OrdersTable.tsx:129`, `OrderContents.tsx:94`), `<a href="#">` toggles (`CalibrationAccuracy.tsx:320`), `key={i}` | Real `<a>` or `tabIndex`+`onKeyDown`; buttons with `aria-pressed` | 📋 |
| P-17 | medium | LOW | `actions.ts` 698 lines / `LabelEditor.tsx` 688 / `CalibrationAccuracy.tsx` 494 / `EmployeesList.tsx` 462 | Split actions by domain (matching `box-/quote-/site-actions.ts`); extract `useDxfPockets`, `useSerializedAutosave` | 📋 |
| P-18 | medium | LOW | Stage/state label maps in 7 places (`types.ts:48`, `page.tsx:35,79`, `OrderContents.tsx:45`, `queue/page.tsx:18`, `QuotesSection.tsx:24`, `DrawerQuickView.tsx:61`) | One `lib/labels-map.ts` | 📋 |
| P-19 | medium | LOW | `GenerateQuoteModal.tsx:87-106` and `DrawerQuickView.tsx:68-85` re-implement `Modal` chrome because `Modal` has no controlled `open` | Extend `Modal` with `dialogRef`/`open`/`onClose` | 📋 |
| P-20 | medium | LOW | 386 inline `style={{}}` objects (`OrderContents` 29, `CalibrationAccuracy` 29, `StatusPipeline` 26 …) vs house style | `.kpi`, `.row`, `.stack`, `.linetable` utilities in `globals.css` | 📋 |
| P-21 | low | LOW | Dead exports (knip-confirmed): `setCustomerOrgAction`, `assignDrawerToBoxAction`, `setDrawerQuantityAction`, `createQuoteAction`, `getUserEmail`; `POCKET_OUTLINE` exported needlessly | ✅ removed | ✅ |
| P-22 | low | LOW | `fmtDate` ×7, `AgeBadge` ×2, `pct` ×2, `generatePassword` ×2, `EMAIL_RE` ×2, dollars→cents ×3, customer `<option>` label ×5 | `lib/format.ts`, `components/AgeBadge.tsx`, `customerOptionLabel()` | 📋 |
| P-23 | nit | LOW | `OrderStateControls.tsx:1`, `EditOrderModal.tsx:1` carry `"use client"` without hooks/handlers | Remove (bundle-size only) | 📋 |
| P-24 | low | LOW | `revalidatePath` targets don't match where actions are used (`assignOrderAction:24`, `createCustomerAndAssignAction:46`, `markDeliveredAction:623`) — masked by `force-dynamic` | Revalidate `/admin/orders` + `/admin/orders/[id]` like `updateNicknameAction` | 📋 |
| P-25 | low | LOW | Sequential awaits in `orders/page.tsx:33-61`; dashboard issues one `get_order_tracker` per order | `Promise.all`; later a set-returning `get_my_order_trackers()` | 📋 |
| P-26 | low | LOW | "Apply the migration" branches for RPCs live since June/August (`page.tsx:248,293`, `labels/[id]:31,55`) — customer-facing copy told customers to run SQL | ✅ removed | ✅ |
| P-27 | low | LOW | `set-password/page.tsx` unused `useRouter` | ✅ | ✅ |
| P-28 | low | LOW | Dead CSS `.card--danger`, `.qv__drawer`, `.lbl-banner` | ✅ | ✅ |
| P-29 | low | LOW | Google Fonts via render-blocking `<link>` (`layout.tsx:18-28`) | `next/font/google` (self-hosted, no layout shift) | 📋 |
| P-30 | low | LOW | `npm run lint` = `next lint` with no ESLint config or dependency → interactive prompt; all `eslint-disable` comments are inert; Next 16 removes `next lint` | Add `eslint` + `eslint-config-next` devDeps + flat config, script `eslint src` (new dev deps → sign-off) | 📋 🔶 |
| P-31 | nit | LOW | `Header` prop `isAdmin` means "show the Admin link" (staff get it too) | Rename `showAdminLink` | 📋 |

### 4.2 Portal — lib, config, edge function

| ID | Sev | Risk | Finding | Fix | Status |
|---|---|---|---|---|---|
| L-1 | medium | LOW | `types.ts` is hand-written (no `supabase gen types` anywhere); `DrawerEvent.event_type` had 5 of 8 CHECK values; `DrawerApproval` omits `approval_note` | ✅ event types fixed. 📋 `types:gen` script → `database.types.ts`, derive RPC row types from `Database["public"]["Functions"]` so `tsc` catches drift | ✅ / 📋 |
| L-2 | medium | LOW | `parsePricingConfig` (`config.ts:266-311`) doesn't validate `thickness_multipliers`, `costs.*_cents_per_hour`, `default_trips`, `upgrades`, `rounding`; engine throws `TypeError`/produces `NaN` on a malformed row and `save_quote` would store it | Extend the validator; add a negative test (none exists) | 📋 |
| L-3 | medium | HIGH | `_notify_customer_email` / `_notify_labels_submitted` hard-code the **prod** function URL (`20260705231200:53`, `20260803120000:149`); on the `dev` branch a matching Vault secret would email real customers from test data. `verify_jwt=false` lives only as a deploy flag — no `supabase/config.toml` | Read the URL from Vault/`current_setting`; add `config.toml` with `[functions.notify] verify_jwt = false`; document the five function secrets (✅ README) | 📋 🔶 |
| L-4 | low | LOW | `pocketColor(_index)` ignores its argument; `PocketSet.numberedByDxf` computed, never read | Drop or use ("numbers from tidyCAD" badge) | 📋 |
| L-5 | low | LOW | Pricing tests never exercise: legacy travel-priced delivery (`engine.ts:362-379`), thickness defaults/warnings, `dh > 12`, `flat`/`per_sqft` upgrades, `gross_margin === null`, every validator `throw`, `normalize.ts` unit branches, QB `upgrade`/`min_order_adjustment` rows. No tests for `labels.ts` (342-line DXF parser), `dxf.ts`, `distance.ts` | Add cases; `labels.ts` deserves a fixture DXF | 📋 |
| L-6 | low | LOW | `per_drawer` upgrades use design×copies, `per_sqft` uses design area only (`engine.ts:316-317`); dormant, undocumented | Decide and document before the first upgrade ships | 📋 |
| L-7 | low | LOW | Stale pricing comments: `default_trips` "2" (v4 = 1), "$40 floor" (v4 = 0), "update to v3" (config is v4), test title contradicts its body (`engine.test.ts:226`) | Fix comments | 📋 |
| L-8 | low | LOW | README omitted `SUPABASE_SECRET_KEY`, `GOOGLE_MAPS_API_KEY`, `SHOP_ORIGIN_ADDRESS`, edge secrets; described magic-link + email-bridge auth | ✅ | ✅ |
| L-9 | low | HIGH | `listUsers({perPage:1000})` + `find` by email (`actions.ts:438,561`) — user #1001 is "not found" | Tiny `admin_auth_user_id_by_email` RPC or paginate | 📋 |
| L-10 | low | LOW | `config.ts:5-9` non-null `!` on env; missing var surfaces deep inside supabase-js. No `server-only` imports on `server.ts`/`admin.ts`/`distance.ts` | Explicit throws; `import "server-only"` so a future client import fails at build | 📋 |
| L-11 | low | LOW | `test:pricing` = `npx -y tsx` — unpinned, network-fetched runner | `tsx` devDependency | 📋 |
| L-12 | low | LOW | Next 16: `next lint` removed, `middleware.ts` → `proxy.ts`. Current `next@15.5.19` is past CVE-2025-29927 and every page re-checks auth anyway | Plan the rename with the lint fix | 📋 |
| L-13 | nit | LOW | `middleware.ts:37` prefix-matches `/login`/`/auth` (`/loginx` is public); `notify/index.ts:12,135,161` bake a personal Gmail default into a public repo; secret compare not constant-time; `distance.ts:41` `units=imperial` unused | Exact match; make `NOTIFY_REPLY_TO` required (edge redeploy) | 📋 |

### 4.3 Database (migrations, RLS, RPCs)

| ID | Sev | Risk | Finding | Fix | Status |
|---|---|---|---|---|---|
| D-1 | high | HIGH | `20260705173400`, `20260705173519`, `20260705182905` sort before `20260706000000`/`20260707000000` but were applied after them (their own headers say so). Version-ordered replay fails at `20260706000000` with `42P13` on `get_admin_customers` — **not** `get_my_drawers` as `SUPABASE.md` and `dev-environment-handoff.md` claimed — and the documented fix (`drop function if exists` guard) would leave the wrong 5-column version live, breaking the Customers tab | ✅ README caveat + corrected planning docs. 🔶 Repair: remove the 5-column block from `20260706000000`, update dev+prod history rows identically, then add a CI replay on empty Postgres | ✅ / 🔶 |
| D-2 | high | HIGH | `link_customer_on_auth` (`20260704000000:114-141`) fires `after insert on auth.users` and links by `lower(email)` with no `email_confirmed_at` check. With sign-ups enabled on the project, the only wall against "sign up as a customer's email → see their org's orders" is the dashboard **Confirm email** toggle, which nothing in the repo asserts. Prod today: 11 users, 0 unconfirmed | 🅱 `planning/proposed-migrations/01_link_only_confirmed_users.sql`: gate on `email_confirmed_at`, add `update of email_confirmed_at` to the trigger, same predicate in `_try_link_customer_auth`; README now says keep Confirm-email ON | 🅱 |
| D-3 | medium | HIGH | No `AFTER DELETE` trigger on `drawer` → `order.computed_status` stale after `admin_delete_drawer`/bulk delete (e.g. `[delivered, design_queue]` → delete the second → stays `production`) | 🅱 `02_recompute_on_drawer_delete.sql` | 🅱 |
| D-4 | medium | HIGH | `drawer_update_staff` is a full-row policy: any staff/tidyCAM session can write `stage`/`state` directly; the bridge validates the code but records no event; a legacy `status` write can jump `awaiting_approval → in_production`, skipping approval | GUC-gated direct writes (same pattern as `allow_audited_purge`) or record a `system` event; legality check on legacy advances | 📋 🔶 |
| D-5 | medium | HIGH | `recompute_order_status` reads `computed_status` without `for update` (`20260727100000:323`) → lost update / wrong `from_status` under concurrent drawer updates | 🅱 `03_recompute_order_status_lock.sql` (`select … for update`) | 🅱 |
| D-6 | medium | HIGH | `20260812210000` re-created 8 functions (`claim_drawer`, `release_drawer`, `handoff_drawer`, `get_claimable_staff`, `save/get/clear_drawer_progress`, `get_work_queue`) with no `revoke … from anon`; default privileges grant it. **Live advisor confirms all 8 are anon-executable.** Internally `is_staff()`-guarded, so the impact is enumeration + posture, not data | 🅱 `04_revoke_anon_on_claims_rpcs.sql`; README rule 5 | 🅱 |
| D-7 | medium | HIGH | Republishing a design after approval resets `customer_approval_status='pending'` but the bridge never returns `stage` from `approved` to `awaiting_approval` — tracker says "In production" while the customer is asked to re-approve | Bridge: on `pending` while `stage='approved'`, record a `return` event | 📋 |
| D-8 | medium | HIGH | `map_stage_to_legacy` returns NULL for 5 of 11 stages; `get_public_drawer` and `get_my_drawers` still return the legacy enum → QR page shows "In fabrication" forever for delivered drawers (M-4) | Add `stage`, `stage_label` to both RPCs (drop+create, re-grant); `drawer.html` prefers `stage_label` | 📋 |
| D-9 | medium | LOW | `admin_update_order` writes `customer_email` as bare text; the RPC that re-links (`set_order_customer_email`, two explicit modes) is unreferenced by the portal | `updateOrderAction` calls `set_order_customer_email` when the email changed — needs a mode decision | 📋 🔶 |
| D-10 | medium | HIGH | `admin_delete_order` snapshots order/drawers/events but FK cascades silently remove `quote`, `quote_line_item`, `box`, `drawer_label`, `drawer_progress` — "sent numbers are never silently rewritten" is violated on delete | Extend the before-image or refuse to delete orders with `sent`/`accepted` quotes | 📋 |
| D-11 | medium | HIGH | `get_public_drawer` / `get_drawer_approval` return the whole `dimensions` JSON to anon — now including `calibration_matrix`, `correction.corrected_by` (a staff name), `calibration_quality`, `reference_corners`, operator `notes` | 🅱 `05_public_rpcs_project_dimensions.sql` strips internal keys; both pages only read width/height | 🅱 |
| D-12 | medium | HIGH | `employee` (`employee_select_authenticated USING (true)`) exposes names + phones to every signed-in customer; referenced by nothing | 🅱 `06_drop_employee_select_policy.sql`; 🔶 drop the table after confirming tidyCAM doesn't read it | 🅱 / 🔶 |
| D-13 | medium | LOW | `get_drawer_changelog` guard is `is_staff() or created_by = auth.uid()` — customers never match, so `/approve/[id]` History is always empty | Moot if P-6 deletes the route; otherwise use `get_public_drawer_changelog` | 🅱 (via P-6) |
| D-14 | medium | HIGH | Storage: bucket-wide authenticated SELECT on `drawer-assets` was removed in `20260703195701` and re-added in `20260722192713`; broad upload/update policies preserved as debt → any signed-in customer can `list()` every object and overwrite object rows | Scope SELECT to `dxf/…` + owner or `is_staff()`; apply the `TIDYCAM-launch-coordination.md` §2 tightening after a tidyCAM branch test | 📋 🔶 |
| D-15 | medium | LOW | README said byte-for-byte mirror (false for ~40 rows), listed 10 of 54 files, "NOT yet applied" for `20260703220000` (it is applied — verified), required pgTAP (none exists), never mentioned `db_apply.py` | ✅ rewritten | ✅ |
| D-16 | medium | LOW | The two newest migrations were applied via MCP, not `db_apply.py` (normalized rows); MCP applies don't propagate to the `dev` branch | ✅ README rules 2–3 | ✅ |
| D-17 | low | HIGH | No index on `drawer(order_id)` (verified in `pg_indexes`); every recompute, tracker, pipeline aging query filters on it. Duplicate `drawer_id_key` UNIQUE = PK (five FKs depend on that index, so it stays) | 🅱 `07_drawer_order_id_index.sql` | 🅱 |
| D-18 | low | HIGH | `status_event_immutable` is DEFINER (needlessly); no TRUNCATE guard on `drawer_event`/`admin_audit`; TRUNCATE grantable via default privileges; idempotency is check-then-insert (concurrent retry → `23505`); anonymous approvals recorded as `actor_role='system'`; `set_order_customer_email` reassign overwrites an explicit `organization_id`; `drawer_insert_authenticated` requires the inserting operator to own the order; stale "NOT APPLIED" headers; a named-person role grant inside a schema migration (`20260910175336:242`); orphans `set_order_override`, `set_delivery_schedule`, `set_capture_quality`, view `order_capture_quality`, two backup tables | Bundle into the next backbone migration; drop orphans after tidyCAD confirms | 📋 🔶 |

### 4.4 Marketing site (`docs/`)

| ID | Sev | Risk | Finding | Fix | Status |
|---|---|---|---|---|---|
| M-1 | high | HIGH | `notify` `design_ready` email links to `www.thetidytool.com/approve/?id=` (static page, "Review & approve"); the portal removed its approval step and tells the customer "submitting labels is the go-ahead" (`OrderTracker.tsx:7-11`, migration `20260804120000`). Both flows write the same columns, so data is consistent; the instructions are not | **Decide**: (a) keep `docs/approve` canonical and delete the portal twin (P-6), or (b) point `design_ready` at `app.thetidytool.com/labels/<id>` and retire `docs/approve` (leave the RPCs; `publish_for_approval.py:56` and the operator PDF also print the static link) | 🔶 |
| M-2 | medium | HIGH | `docs/CNAME` and every canonical use the apex; engraved QR docs (`q/index.html:10`), `notify/index.ts:39,90` and two planning docs use `www.` | Verify `www → apex` 301 survives the Cloudflare/rebrand move; normalise new code to apex; document the redirect as a permanent contract | 🔶 |
| M-3 | medium | HIGH | `TT_ENVS` (prod legacy JWT anon key + dev publishable key), the `tt_dev` opt-in, `esc()`, `formatDimensions()`, `renderState()` and chip/spinner CSS are copy-pasted between `drawer.html:74-126` and `approve/index.html:128-181` | One `docs/assets/js/tt-supabase.js`; move prod to the `sb_publishable_` key while there | 📋 |
| M-4 | medium | HIGH | QR drawer page renders legacy `status` (see D-8) | With D-8 | 📋 |
| M-5 | medium | HIGH | Segment pages' nav/hero/footer CTAs link `/#quote` (homepage form) although each embeds its own form at `#quote` — full navigation + loss of segment context | Change 6 hrefs to `#quote` — conversion path, so gated | 🔶 |
| M-6 | medium | LOW | `cody.html`/`tilly.html` (children's pages with third-party character art) reachable via hidden footer anchors (`index.html:278`, `cursor:text`) on a B2B production domain and a public repo | Move to a personal repo, or at least remove the hidden anchors | 🔶 |
| M-7 | low | LOW | No `<link rel="icon">` on any page (every load 404s `/favicon.ico`); 45 KB app icon unreferenced | Downscale to 32/180 px and wire favicon + apple-touch-icon, or delete | 📋 |
| M-8 | low | LOW | Dead selectors in `styles.css` | ✅ | ✅ |
| M-9 | low | LOW | `approve/sample-preview.png` (112 KB) never referenced | ✅ | ✅ |
| M-10 | low | LOW | Privacy link only on the homepage; `privacy.html` h1→h3; case-study page has no `og:*`; no skip link / `:focus-visible`; `.nav-toggle` lacks `aria-controls`; `approve/index.html:186,189` hard-code `https://thetidytool.com/` | Small copy/markup pass | 📋 |
| M-11 | low | LOW | Google Fonts render-blocking on 8 pages (preconnect + `display=swap` mitigate); install photos are 360×480 and double as `og:image` (recommended 1200×630) | Self-host Inter subset; proper OG image (already an owner item) | 📋 |

### 4.5 Repo & documentation

| ID | Sev | Risk | Finding | Fix | Status |
|---|---|---|---|---|---|
| R-1 | medium | LOW | `tools/__pycache__/*.pyc` tracked (one from a deleted source; docstring with prod URL extractable via `strings`); no `__pycache__`/`.venv` ignore though the operator guide creates `tools/.venv` | ✅ untracked + ignored | ✅ |
| R-2 | medium | LOW | CLAUDE.md "Current priorities"/"Backend note", root README (Tally placeholder, Cloudflare deploy), portal README (magic link, email bridge, coming-soon page), migrations README, ROADMAP (merged PRs "in review", T4 "biggest gap" though the stepper shipped), dangling `DB-baseline-runbook.md` refs ×5, wrong migration filename in the SMTP runbook, `memory/` phone claim | ✅ all corrected | ✅ |
| R-3 | low | LOW | PM-agent apparatus (`planning/STATUS.md` last run 2026-07-12, `pm-agent.md` "runs every 3 days", `memory/`) is dormant and STATUS contradicts 20+ merged PRs | Re-enable the scheduled task or delete STATUS.md + `memory/` and mark `pm-agent.md` dormant | 🔶 |
| R-4 | low | LOW | Specs for shipped features still read as proposals (`FEATURE-approval-changelog.md` "Proposed", `TIDYCAM-launch-coordination.md` "nothing applied", `employees-tab-eval.md`, `phase-4-architecture-prompt.md`, `label-tool-prototype.html`, `customer-interview-form.pdf`) | `planning/archive/` (git mv keeps history) | 🔶 |
| R-5 | medium | LOW | No CI of any kind: nothing runs `tsc`, the pricing tests, knip, a link check, or a migration replay on push; `tsc` and Vercel's build are the only gates | See §7, horizon 2 | 📋 |

---

## 5. Dead code — what was removed and what remains

Removed in PR A (all confirmed by knip or grep, `tsc` clean afterwards):
`setCustomerOrgAction`, `assignDrawerToBoxAction`, `setDrawerQuantityAction`,
`createQuoteAction`, `getUserEmail`, the `POCKET_OUTLINE` export, an unused `useRouter`, the
two PGRST202 "apply the migration" branches, `.card--danger`/`.qv__drawer`/`.lbl-banner`,
`.nav-phone`/`.form-placeholder`/`.cost-grid`/`.cost .big`/`.grid--5`/`.center`,
`docs/approve/sample-preview.png`, `tools/__pycache__/`.

Flagged, not removed (each needs a decision or a migration):

| What | Why it's still here |
|---|---|
| `portal/src/app/approve/[id]` + 2 components + `formatDimensions` | Product decision (M-1); isolated commit in PR B |
| SQL functions `set_order_override`, `set_delivery_schedule`, `set_capture_quality`; view `order_capture_quality`; columns `drawer.capture_quality*` | Might be tidyCAD surfaces nobody wrote down — confirm in that repo first |
| Tables `employee`, `drawer_backup_2026_05_02`, `_archive_customer_2026_07_03` | Deleting data → gated; `employee` is also a policy question (D-12) |
| `_drawer_stage_sort` duplicates `status_sort` | Harmless; fold into the next backbone migration |
| `realtime` publication of `"order"` | No subscriber in this repo |
| `docs/images/logos/Icon-App-1024x1024@1x.png` | Becomes the favicon if M-7 is done |
| `planning/STATUS.md`, `memory/`, shipped-feature specs | R-3 / R-4 |
| `PocketSet.numberedByDxf`, `pocketColor(_index)` param | L-4; trivial, bundle with the next LabelEditor change |

---

## 6. Adversarial review — how this breaks

Read this section as "what would I try if I wanted to embarrass the system", ordered by
who is doing the trying.

### 6.1 An outsider with the publishable key (it is in the HTML of every `docs/` page)

1. **Sign up as a customer.** `auth.signUp({email: victim@customer.com})` fires
   `link_customer_on_auth` at INSERT; the customer row is linked before any confirmation.
   If **Confirm email** is ever switched off in the dashboard (or a future auth provider
   marks emails confirmed), `get_my_drawers` returns the victim's whole *organization's*
   orders, tracker and label editor. Nothing in the repo asserts that setting. → D-2.
2. **Enumerate RPCs.** `/rest/v1/rpc/` lists 12 anon-executable DEFINER functions; 8 of
   them are tidyCAD claim/progress RPCs that should never have been exposed. They fail with
   42501, but they tell an attacker the shape of the internal workflow. → D-6.
3. **Harvest via a leaked link.** A single forwarded approval email exposes
   `dimensions` including a staff member's name, calibration internals and operator notes,
   plus the full changelog with actor names. The rate limit (10/h/drawer) and input caps hold
   up; the projection does not. → D-11.
4. **Phish through the auth callback.** `/auth/confirm?code=…&next=https://evil` lands a
   just-authenticated customer on an attacker page. Needs a valid one-time code, so
   exploitability is low — but the fix is one line. → P-5.

### 6.2 A customer with a legitimate login

5. **Burn the Google Maps budget.** POST the `lookupOrderDistanceAction` server action
   with any address; the Distance Matrix call is billed before `admin_set_order_site`
   rejects them. Server actions are just HTTP endpoints. → P-3.
6. **Read the staff directory.** `select * from employee` — RLS says any authenticated
   user may. → D-12.
7. **List the whole asset bucket.** `storage.from('drawer-assets').list()` returns every
   object (photos, DXFs, previews for every customer) thanks to the bucket-wide SELECT
   re-added in `20260722192713`; the broad UPDATE policy lets them rewrite object metadata.
   Buckets are public-read anyway, but listing is enumeration. → D-14.

### 6.3 A staff member (or tidyCAM/tidyCAD) doing normal work

8. **Cancel an order from the URL bar.** The UI hides Hold/Cancel/quotes/boxes from staff,
   but the actions and RPCs accept staff. Either the UI lies or the DB is too permissive;
   today nobody has decided which. → P-2.
9. **Skip the customer's approval.** tidyCAD writes legacy `status='received_by_fabricator'`
   on a drawer that is `awaiting_approval`; the bridge advances to `in_production` without a
   legality check, no `status_event` says who did it. → D-4.
10. **Leave the order status wrong forever.** Delete the one un-delivered drawer of an order;
    nothing recomputes; the customer's tracker keeps saying "In production". → D-3. Two staff
    advance two drawers of one order in the same second; the second recompute overwrites the
    first with a stale `from_status`. → D-5.
11. **Republish a design after approval.** The customer gets a "please re-approve" email while
    their tracker shows step 5 "In production". → D-7.
12. **Change a customer's email on the order form.** The text field changes, the customer
    link doesn't, and the list view hides the discrepancy behind `coalesce(c.email,
    o.customer_email)`. The RPC built for exactly this incident (`set_order_customer_email`)
    is never called by the portal. → D-9.
13. **Price a quote while the `box` query hiccups.** Every boxed drawer prices as 1 copy; the
    quote saves and is sent. Nobody sees an error. → P-1.
14. **Hit any DB guard from the Customers tab** ("customer has orders"): before PR A that was
    Next's grey production error page; now it's a banner with a retry. → P-4.

### 6.4 An engineer setting up a new environment

15. **`supabase db reset` / a schema-only branch** dies at migration 16 of 54. The two
    planning docs that describe this blamed the wrong function and prescribed a fix that
    would silently break the Customers tab in the new environment. → D-1.
16. **Deploy `notify` from a fresh machine** without remembering `--no-verify-jwt`: pg_net
    sends no JWT, the function 401s, `_notify_customer_email` swallows the error, and
    customers quietly stop receiving design-ready emails. → L-3.
17. **Apply a prod migration with the MCP tool** and forget to mirror it onto the `dev`
    branch: every Vercel preview now runs against a schema that lags prod. → D-16.
18. **Rotate the legacy anon JWT** (the dashboard now prefers `sb_publishable_` keys): both
    public pages fail with the generic "Something went wrong" because the key is hard-coded
    twice. → M-3.
19. **Trust `npm run lint`.** It prompts interactively and lints nothing. Trust the
    `eslint-disable` comments — they are inert. → P-30.

### 6.5 The business

20. **The customer reads two instructions.** The email says "review & approve"; the portal
    says "submit labels". A customer who does one wonders whether they must also do the
    other; a customer who does neither is waiting on us while we wait on them. → M-1.
21. **QR codes on delivered drawers say "In fabrication".** The homepage promises "scan it
    to see … order status". → D-8/M-4.
22. **The rebrand moves DNS** and the `www` redirect is not recreated: every engraved QR
    code (`www.thetidytool.com/q/…`) and every sent email link 404s, permanently. → M-2.
23. **Hireability** (an explicit goal in CLAUDE.md): a reviewer opening the repo meets a
    700-line actions file with four error conventions, 386 inline style objects, hand-synced
    types, no CI, a lint script that doesn't run, and children's pages linked from the
    production footer. The engineering underneath is good; the first impression undersells it.

---

## 7. Optimistic vision — what's right, and where this can go

### 7.1 What is already excellent (keep doing this)

- **Defense in depth is real.** RLS on every table; every RPC re-checks its role in SQL;
  the app treats its own guards as UX. That is the correct posture for a Supabase app and
  it is applied consistently across ~70 functions.
- **The status backbone is a small event-sourced core** with config-table transitions,
  server-derived actor/time, idempotency keys, a correction pattern with mandatory notes,
  append-only guards with a transaction-local purge gate, and a branch test suite (T0–T18).
  Most teams this size never build this; the ones that do rarely test it.
- **Money is integer cents everywhere**, rounded at each multiply, with QuickBooks rows
  asserting `qty × rate = amount`. Preview and save share one pure `priceQuote`, so what the
  admin saw is what was persisted.
- **The marketing site does one thing.** No framework, no analytics bloat, one form, a
  fallback if the embed fails, JSON-LD that parses, zero broken links, alt text on every
  image, capability pages that carry both prod and dev keys with an explicit opt-in.
- **Migrations are treated as history**, with provenance and a purpose-built apply tool
  that reloads PostgREST — the discipline exists even where the docs lagged.
- **Judgement calls are recorded** in migration headers and planning docs. That is why this
  review could be done from the repo alone.

### 7.2 Horizon 1 — the next two weeks (PR B + decisions)

1. Merge PR A. Review PR B commit-by-commit: distance-guard, open-redirect, quote box
   error, employees guard, shared `requireAdmin`, optional `/approve/[id]` deletion.
2. Decide P-2 (staff vs admin for state/quotes/boxes) and M-1 (which approval flow is
   canonical). Both are ten-minute conversations that unblock three findings each.
3. Apply the proposed migrations in `planning/proposed-migrations/` in order on a data
   clone branch, run `status-backbone-branch-tests.sql`, then prod via `db_apply.py`, then
   mirror to `dev`. Bundle: confirmed-only linking (D-2), recompute on delete (D-3), row lock
   (D-5), revoke anon on the 8 RPCs (D-6), dimension projection (D-11), employee policy
   (D-12), `drawer(order_id)` index (D-17).
4. Verify in the Supabase dashboard that **Confirm email** is ON and record it in
   `planning/SUPABASE.md` as a security invariant.
5. `curl -I https://www.thetidytool.com/q/?d=x` → expect a 301 to apex; write the redirect
   into the rebrand checklist.

### 7.3 Horizon 2 — the next quarter (make drift impossible)

- **Generated types.** `supabase gen types typescript` → `src/lib/database.types.ts`;
  derive every RPC row type from `Database["public"]["Functions"][name]["Returns"]`.
  `tsc` then catches the class of bug L-1 found by hand.
- **A CI workflow** (GitHub Actions, ~40 lines): `tsc --noEmit`, `npm run test:pricing`,
  `knip`, a `docs/` link/anchor check (the script from this review can be committed under
  `tools/`), and — after D-1 is repaired — replay all migrations on a Postgres container.
  Vercel preview builds are not a substitute for a green check on the PR.
- **Lint that runs.** `eslint` + `eslint-config-next` + flat config; rename `middleware.ts`
  → `proxy.ts` in the same change to get ahead of Next 16.
- **One error contract** for server actions (write it in CLAUDE.md's house style), then
  migrate the nine `throw` sites; keep `admin/error.tsx` as the safety net.
- **Split `actions.ts`** by domain (`customer-actions`, `order-actions`, `employee-actions`)
  and extract the five duplicated helpers into `lib/format.ts`, `useSelection()`, `AgeBadge`.
- **Finish the backbone**: transactional cascade RPCs (P-7), GUC-gated direct writes (D-4),
  `pending → awaiting_approval` return (D-7), `stage_label` on the public RPCs (D-8) so the QR
  page finally tells the truth, complete delete before-images (D-10).
- **One approval flow**, whichever M-1 chooses; retire the other's code and update
  `notify`, `publish_for_approval.py` and the operator PDF together.
- **Shared `tt-supabase.js`** for the two public pages, prod on the `sb_publishable_` key.
- **Tests for `labels.ts`** with a fixture DXF — it is the most complex untested code in the
  repo and it sits on the customer's path.

### 7.4 Horizon 3 — when volume justifies it

- **A contract package for tidyCAM/tidyCAD**: the RPC names, argument shapes, enum values and
  URL formats in `architecture-diagram.md` §6, published as a versioned JSON/TypeScript
  artefact both apps consume, with a CI check that a migration touching a contract function
  bumps the version.
- **Customer-visible history**: a customer-scoped changelog RPC (or `drawer_event` RLS)
  feeding the tracker — the last piece of T4.
- **Reorders and saved designs** (already correctly deferred in ROADMAP) become cheap once the
  backbone and quoting are stable: a reorder is a new order whose drawers copy `dxf_url` +
  labels and enter at `approved`.
- **Observability**: `status_event` already is the audit log; a weekly `select
  recompute_order_status(id)` reconciliation and an advisor snapshot in CI would catch the
  drift classes found here before a human does.

### 7.5 What not to do

- Don't add a framework, bundler or component library to `docs/`. Its lack of moving parts
  is why it had zero defects of substance.
- Don't reach for an ORM or a state library in the portal; the RPC-per-use-case pattern plus
  server components is doing the job and is the stated hiring signal.
- Don't renumber applied migration files to "fix" ordering; repair the one file and its
  history rows as D-1 describes, so version+name stays 1:1 with prod.
- Don't merge `docs/approve` into the portal just to have one codebase; the no-login link is
  a feature for customers who will never create an account. Choose which flow is canonical,
  don't collapse them.

---

## 8. Decisions needed from Sam / Shem

| # | Decision | Unblocks |
|---|---|---|
| 1 | Staff may / may not hold, cancel, quote and manage boxes (UI says no, DB says yes) | P-2, and whether PR B's app guards stay or the UI gates go |
| 2 | Canonical approval flow: `docs/approve` (email link) or portal labels | M-1, P-6, D-13, `notify` email copy, operator PDF |
| 3 | Repair the migration history (`20260706000000` + dev/prod rows) now, or keep "data-clone branches only" | D-1, any future CI replay |
| 4 | Apply the seven proposed migrations (§7.2 step 3) | D-2, D-3, D-5, D-6, D-11, D-12, D-17 |
| 5 | Drop `employee`, the two backup tables, and the three orphan RPCs after a tidyCAD check | D-12, D-18 |
| 6 | Segment-page CTAs → local `#quote` | M-5 |
| 7 | Move `cody.html`/`tilly.html` off the production domain (or unlink them) | M-6 |
| 8 | PM agent: revive or retire (`STATUS.md`, `memory/`); archive shipped specs to `planning/archive/` | R-3, R-4 |
| 9 | Allow the ESLint + `tsx` dev-dependencies | P-30, L-11 |
| 10 | Storage policy tightening from `TIDYCAM-launch-coordination.md` §2 (needs a tidyCAM branch test) | D-14 |

---

## Appendix A — route → guard → RPC inventory

| Route | Guard | Reads | Writes |
|---|---|---|---|
| `/` | middleware + `getClaims` | `get_my_drawers`, `get_my_label_status`, `is_admin`, `is_staff`, `get_order_tracker`×N | — |
| `/login`, `/set-password` | public / session | — | auth (browser) |
| `/auth/confirm` | public | — | `verifyOtp` / `exchangeCodeForSession` |
| `/labels/[id]` | `getClaims` | `get_drawer_labels` | `save_drawer_labels`, `submit_drawer_labels`, `set_drawer_reference_corners` (browser) |
| `/approve/[id]` (orphan) | session | `get_drawer_approval`, `get_drawer_changelog` | `submit_drawer_approval` (browser) |
| `/admin` layout | `is_admin ∨ is_staff` else `/` | — | — |
| `/admin` | layout | `get_status_pipeline`, `get_admin_pipeline`, [admin] orphans + customers; realtime `status_event` | assign / create customer / bulk assign / bulk delete / bulk deliver / mark delivered |
| `/admin/queue` | layout | `get_work_queue` | — |
| `/admin/orders` | layout | `get_admin_orders`, [admin] `get_admin_customers` | `admin_create_order`, bulk assign/delete |
| `/admin/orders/[id]` | layout | `get_admin_order_detail`, `get_quotes_for_order`, `pricing_config`, [admin] customers | order update/assign/delete/site/state, drawer state/nickname/deliver, box CRUD + placement, `save_quote`, `set_quote_status`, Google Distance Matrix |
| `/admin/orders/[id]/dxf` | `getClaims` + `is_staff` | `get_admin_order_detail`, Storage | — |
| `/admin/customers` | `requireAdminPage` | `get_admin_customers`, `get_admin_organizations` | customer CRUD/merge/org; service-role invite / createUser / listUsers / updateUserById |
| `/admin/organizations` | `requireAdminPage` | `get_admin_organizations` | org CRUD |
| `/admin/employees` | RPC error only (PR B: `requireAdminPage`) | `admin_list_users` | grant/revoke staff + admin; service-role user ops |
| `/admin/history` | `requireAdminPage` | `get_admin_audit` | — |
| `/admin/accuracy` | `requireAdminPage` (RPCs are staff) | calibration series/summary; realtime `drawer` | — |

## Appendix B — environment variables

| Variable | Read in | Documented |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (fallback `_ANON_KEY`), `NEXT_PUBLIC_SITE_URL` | `lib/supabase/config.ts`, `login/page.tsx`, `admin/actions.ts` | `.env.example`, README |
| `SUPABASE_SECRET_KEY` (fallback `SUPABASE_SERVICE_ROLE_KEY`) | `lib/supabase/admin.ts` | `.env.example`, README (now) |
| `GOOGLE_MAPS_API_KEY`, `SHOP_ORIGIN_ADDRESS` | `lib/distance.ts` | `.env.example`, README (now) |
| `VERCEL_URL` | `admin/actions.ts:380` (platform) | comment only |
| `NOTIFY_HOOK_SECRET`, `RESEND_API_KEY`, `NOTIFY_FROM`, `NOTIFY_REPLY_TO`, `NOTIFY_OWNER` | `functions/notify/index.ts` | README (now); Vault twin `notify_hook_secret`, `discord_approval_webhook` |

Exactly four values are `NEXT_PUBLIC_`; no secret is reachable from a client component
(verified by import-graph walk).

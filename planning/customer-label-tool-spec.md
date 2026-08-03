# Customer Label Tool — requirements & build spec (v2)

*2026-08-03. Reviewed portal + database, prototyped the UX (`planning/label-tool-prototype.html`), and locked the design decisions with Sam. This version supersedes the v1 gap analysis; it is the requirements doc for the roadmap.*

---

## Goal

Customers with design-complete drawers sign in, see each drawer as its **orthographic photo with color-coded, numbered pocket outlines overlaid**, and type the desired label for each pocket (or check N/A). Sam uses the collected names to fill in labels before the foam is cut.

## Locked decisions (Sam, 2026-08-03)

1. **Per-pocket labels**, plus the customer may rename the drawer (updates `nickname`).
2. **One view only**: outlines overlaid on the top-down **orthographic** image. No diagram/photo toggle. Colors + numbers are a matching aid only — nothing color-related is stored.
3. **N/A checkbox** per pocket for pockets that don't need a label.
4. **Small-scale account model — no automated customer emails anywhere.** Sam creates one login per customer (email + password via the existing admin "Set a password instead" control) and relays the credentials himself — including to multiple people at one company who share the login. Sam handles password resets from the admin row. The invite-email path stays available but unused.
5. **Attribution by typed name**: like the approval form, the label submit asks for the submitter's name (`labels_submitted_by`), so a shared login still leaves an audit trail.
6. **Auto-save drafts**: entries persist as the customer types; an explicit **Submit** marks the drawer's labels done. Partial progress is visible in admin.
7. **No label text limit.** Free text, one field per pocket; Sam adjusts wording at manufacturing time if something won't fit. (UI may show a gentle "long labels may be abbreviated" hint — no enforcement.)
8. **Auto-lock at `in_production`**: labels are editable from design-complete through QC/approval, and freeze when the drawer's stage enters `in_production`. No manual step.
9. **Notify Sam by email (Resend)** on submit — "Labels submitted for [drawer]" via the existing `notify` plumbing. Internal only; not customer-facing.
10. **Manufacturing output v1**: admin order-page label list + CSV/print sheet. **v2 (optional)**: replace the `object N` placeholder text on the DXF `Labels` layer with the customer's text, emitting a `*_labeled.dxf` — pending the V1 verification below.

## Ortho image — VERIFIED in tidyCAM source (2026-08-03)

**`drawer.photo_url` already IS the orthographic image — no new column, no tidyCAM change needed.** Verified in the tidyCAM repo:

- The scan flow renders an **orthographic top-down PNG from the 3D model** (`drawer_scan_service.dart` — "builds a 3D model AND renders an ortho photo from it"; `orthoPhotoPath` throughout `drawer_scan_bloc`/`drawer_scan_capture_screen`).
- `add_drawer_screen.dart` sets the drawer's `photoPath` to that ortho PNG (`UpdatePhotoPath(result.orthoPhotoPath)`), and `supabase_order_service.dart` uploads `photoPath` as **`photo_url`** to the `drawer-assets` bucket.
- **Alignment data**: after the ortho render, the operator taps the drawer's four outer corners on that photo (`photo_calibration_page.dart`); current builds persist them normalized (0–1, TL/TR/BR/BL) as **`dimensions.reference_corners`** alongside real width/height (`add_drawer_screen.dart:817` → `supabase_order_service.dart:230`). Overlay mapping = fit the DXF `BoundaryBox` rectangle onto the `reference_corners` quad — a plain affine fit, since the photo is a true ortho render. `dimensions.calibration_quality.score` can gate cases where the fit shouldn't be trusted.

**Legacy caveat (measured in prod):** of 59 design-complete+ drawers, 55 have a `photo_url` but only **2** have `reference_corners` — most predate corner persistence. Every *new* scan gets corners automatically. For the back-catalog, ship a tiny **admin align tool**: drag four corners on the drawer photo (same UX tidyCAM uses, ~10 s per drawer) saved into `dimensions.reference_corners` via a staff RPC. Drawers not yet aligned fall back to the side-by-side numbered plan.

## Phase 0 — DXF verification COMPLETE (2026-08-03, 17 prod files parsed)

All modern (ezdxf/AC1024) tidyCAD exports share one structure — confirmed across every designed drawer sampled, including all of Mike Tolson's:

- **Units inches** (`$INSUNITS=1`); `BoundaryBox` layer = 1 closed LWPOLYLINE matching the drawer's stored dimensions (validated against `dimensions` width/height).
- **Pockets** = LWPOLYLINEs on `Outline` **plus CIRCLEs** (round pockets). Each has a unique entity handle. ⚠️ Outline polylines are NOT flagged closed (`closed=False`) but first/last vertices coincide exactly — detect closure by endpoint coincidence, not the flag.
- **`Labels` layer holds one `TEXT` entity per pocket — "Object 1", "Object 2", …** — verified invariant: `TEXT count = (LWPOLYLINEs − 1) + CIRCLEs` in all 15 modern files. Use tidyCAD's own Object-N numbering as `pocket_index` and match text→pocket by point-in-polygon (14/15 inserts land inside their pocket; fall back to nearest-polygon for edge cases like one observed "Object 12").
- **Pocket counts range 3–66** (Top Drawer = 66) — the entry list needs to stay usable at 60+ rows (grouping/search nice-to-have, not required).
- **Output v2 (labels into DXF) is confirmed cheap**: replacing each "Object N" TEXT string in place preserves position/height/layer — a string substitution, not a placement problem.
- **Legacy exception:** pre-refresh test drawers (`alignment_tools`, `test2 :)`) have no `Labels` layer/TEXT — fall back to centroid numbering; none belong to active customers.

Note on fetching: the DXFs were pulled via `pg_net` (`net.http_get` → `net._http_response`) since the analysis sandbox can't reach the storage bucket directly; the portal fetches them client-side as usual.

---

## What already exists (no build needed)

- **Auth & provisioning**: invite-only accounts; admin per-customer "Set a password instead" (generate/copy/create, never emailed) and "Reset their password"; email+password login; `/set-password` link flow for the rare self-serve case.
- **Scoping**: `get_my_drawers()` via `customer.auth_user_id = auth.uid()` with whole-org visibility; dashboard groups drawers by order with the pizza tracker; `/approve/[id]` approval screen with changelog.
- **Lifecycle**: status backbone (`designed` = sort_order 40 = design-complete; `DESIGNED_SORT` in `types.ts`); `drawer_event` append-only log; `record_dxf_upload` maintains `dxf_revision`.
- **~56 drawers in prod** are at or past design-complete today; nearly all have a `dxf_url` (mixed URL/path formats — normalize with existing `dxfPublicUrl()`); most have **no** `design_preview_url`, which is why the DXF is the geometry source.

## What gets built

### Schema (one migration — production DDL ⇒ Sam sign-off gate)

```sql
create table drawer_label (
  id            uuid primary key default gen_random_uuid(),
  drawer_id     uuid not null references drawer(id) on delete cascade,
  pocket_key    text not null,          -- DXF entity handle (stable within a file)
  pocket_index  int  not null,          -- display order: centroid top-left → bottom-right
  label_text    text,                   -- free text; null when na = true
  na            boolean not null default false,
  dxf_revision  int,                    -- revision the entry was written against
  updated_at    timestamptz not null default now(),
  unique (drawer_id, pocket_key)
);
alter table drawer
  add column labels_submitted_at timestamptz,   -- null = draft/in progress
  add column labels_submitted_by text,          -- typed name (shared-login attribution)
  add column labels_locked_at    timestamptz;   -- set by the in_production transition
-- photo_url already holds the ortho image; alignment lives in dimensions.reference_corners.
-- Staff RPC set_drawer_reference_corners(p_id, p_corners) backfills legacy drawers.
```

RLS deny-all; access only through SECURITY DEFINER RPCs (house pattern):

- `get_drawer_labels(p_drawer_id)` — customer-scoped (same join as `get_my_drawers`); returns rows + `dxf_url` + `photo_url` + `dimensions` (reference_corners) + `dxf_revision` + locked flag.
- `save_drawer_labels(p_drawer_id, p_rows jsonb)` — **draft auto-save**: upserts rows, no event, rejects when locked.
- `submit_drawer_labels(p_drawer_id, p_name, p_nickname)` — validates every pocket has text or N/A, stamps `labels_submitted_*`, optionally updates `nickname`, appends `drawer_event` (`labels_submitted`), triggers the Resend email to Sam.
- Lock: the existing stage-transition path sets `labels_locked_at` when stage becomes `in_production`.
- Admin: labels included in `get_admin_order_detail` (or a small `get_order_labels`).

### Customer UI (`portal/src/app/labels/[id]`)

Per the prototype: ortho photo with overlaid color/numbered pocket outlines. DXF parsed client-side: pockets = endpoint-closed `Outline` LWPOLYLINEs + `CIRCLE`s, keyed by entity handle, **numbered by the `Labels`-layer "Object N" text** (point-in-polygon match, nearest-polygon fallback) so portal numbering matches tidyCAD's. Entry list with swatch+number, free-text input, N/A checkbox; hover/click sync in both directions; drawer-name field; progress bar; Submit disabled until all pockets covered (drafts auto-save regardless); locked state renders read-only with "in production" notice. Handles up to ~66 pockets per drawer (largest observed). Dashboard: "Name your tools →" CTA + per-order "N drawers need tool names" banner for `stage_sort >= 40` drawers without `labels_submitted_at`; "Labels ✓" badge after.

Revision safety: rows carry `dxf_revision`; when a new DXF is uploaded, mismatched drawers show "the design changed — please re-check your labels" and re-match pockets by handle, then centroid proximity.

### Admin / manufacturing (v1)

Labels section per drawer on the admin order page (pocket #, text, N/A struck), per-order CSV export + print-friendly sheet (drawer name, numbered list, mini pocket map). Resend notification on each submit.

## Estimate

| Phase | Work | Est. |
|---|---|---|
| 0 | V1 DXF verification script | ~1 hr |
| A | Migration + RPCs + lock hook | ~½ day (+ review gate) |
| B | DXF parse → overlay UI → autosave/submit → dashboard CTAs | ~2 days |
| C | Admin view + CSV/print + Resend notify | ~½ day |
| — | **v1 total** | **≈ 3 days** |
| D (opt.) | Admin align tool for legacy drawers (drag 4 corners → save reference_corners) | ~½ day |
| E (opt.) | `*_labeled.dxf` text injection — Phase 0 confirmed it's an in-place string swap | ~½ day |

## Appendix — Mike Tolson drawer audit (goal-line check, 2026-08-03)

15 drawers across 2 orders. **None are permanently blocked.** 2 work out of the box, 11 need only the one-time admin corner alignment (~10 s each), 2 have no DXF yet because they aren't design-complete (correct behavior — they appear when designed).

| Drawer (order) | Stage | Pockets | Verdict |
|---|---|---|---|
| MT Frontier — Hand Tools (A) | designed | 15 | ✅ **Works now** — corners ✓ (calib 92.5) |
| MT Frontier — Large Drawer (A) | designed | 54 | ✅ **Works now** — corners ✓ (calib 97.5) |
| MT Frontier — Measuring Tools (A) | designed | 16 | 🟡 Admin align (no corners) |
| MT Frontier — Ball Screw Linear Slide (A) | designed | 8 | 🟡 Admin align |
| MT Frontier — Chains (A) | designed | 7 | 🟡 Admin align |
| MT Frontier — Pullers/Shims (A) | designed | 8 | 🟡 Admin align |
| MT Frontier — Dial Indicators (A) | designed | 5 | 🟡 Admin align |
| MT Frontier — Bearing/Seals (A) | designed | 8 | 🟡 Admin align |
| MT Frontier — Mount/Support Plates (A) | scanned | — | ⛔ No DXF yet (not design-complete — appears once designed) |
| Top Drawer (B) | designed | 66 | 🟡 Admin align — biggest drawer in prod, stress-tests the list UI |
| Mount/Support Plate (B) | designed | 8 | 🟡 Admin align |
| Measuring Tools (B) | design_queue | 13 | 🟡 DXF ready; shows once stage ≥ designed + align |
| Puller/Clamps (B) | design_queue | 13 | 🟡 DXF ready; shows once stage ≥ designed + align |
| Mount Support 1 (B) | design_queue | 6 | 🟡 DXF ready; shows once stage ≥ designed + align |
| Spacers (B) | design_queue | — | ⛔ No DXF yet (appears once designed) |

All 15 have scan-flow ortho photos (`photo_*.png`). Pocket counts derived from parsed DXFs: `(LWPOLYLINE − 1) + CIRCLE`.

**Out of scope (decided):** automated invite/notification emails to customers; per-person logins for multi-user companies (shared credential instead; org route remains if ever needed); label color choices; text-length enforcement.

## Amendments — pre-merge review round (2026-08-03, commit 687fa27)

Accepted during the pre-merge code review; supersede the matching locked decisions above where they differ:

- **Decision 7 (no text limit), amended:** a 500-character server-side sanity cap now applies to label text and drawer name (200 for the submitter's name), mirrored by `maxLength` on the inputs. Intent unchanged — labels are free text and Sam adjusts wording at manufacturing time; the cap only blocks accidental/abusive megabyte strings.
- **Decision 6 (auto-save), extended:** the drawer rename now persists with auto-saved drafts (`save_drawer_labels.p_nickname`), not only on submit.
- **Decision 8 (auto-lock), extended:** cancelled drawers (`drawer.state = 'cancelled'`) count as locked everywhere — no edit, no submit, no dashboard CTA, no notify email.
- **Robustness:** editability is computed server-side (`get_drawer_labels.editable` — stage ≥ designed and not locked); auto-saves are serialized client-side so an older replace-all write can never land after a newer one; submit flushes the draft first and aborts if that write fails, and passes the client's pocket count (`p_expected_count`) so a submit over a stale/partial row set is rejected; `save_drawer_labels` stores the client's parsed `dxf_revision` so the "design changed" warning survives a stale-tab autosave; duplicate DXF entity handles are deduped in the parser and rejected by the RPC; pocket outlines are keyboard-accessible; staff get a "Re-align outlines" button when corners already exist.

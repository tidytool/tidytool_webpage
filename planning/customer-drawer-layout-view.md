# Customer "Drawer layout" view — spec + validation plan

Branch `feat/customer-drawer-layout-view` (2026-09-29). Plan of record lives in the claude.ai
project (`customer-drawer-layout-pipeline-2026-09-29.md`); this is the condensed repo copy.

## Goal

After delivery a customer opens any drawer from the dashboard and sees the scan photo with
numbered pocket outlines plus a read-only pocket list — the "which tool goes where" view for
loading tools. Driver: Weber-Ogden Tech received 15 inserts on 2026-09-29.

Front-end only. No migration, no RPC change, no auth change → low-risk tier (CLAUDE.md).
Human gate: Vercel preview checked on a phone by Sam or Shem before merge.

## What changes (all in `portal/src`)

- `lib/labels.ts` — `pixelCorners(dimensions)` reads tidyCAD's pixel-space
  `correction.corner_points` (only when a coordinate > 1); `pixelToNormalized(px, {w,h})`
  divides by the photo's natural size and rejects anything outside [-0.05, 1.05] (corners from
  a different-resolution photo). `referenceCorners` unchanged in behaviour.
- `components/LabelEditor.tsx` — `savedQuad = referenceCorners ?? pixelToNormalized(pixelCorners, nat)`;
  the customer plan-drawing fallback and the staff align prompt wait until corner data is
  resolved (no flash while the photo loads). `viewOnly = drawer.locked` swaps the entry form for a
  read-only **Pockets** card and rewords the captions; hover/click sync between photo and list
  is kept. Staff keep align/re-align on locked drawers.
- `app/labels/[id]/page.tsx` — eyebrow "Drawer layout" + layout intro when locked.
- `app/page.tsx` — idle dashboard rows with photo **and** DXF link to `/labels/[id]`; rows
  without a design file stay inert. Intro mentions the layout view.

## Decisions

- Link gate is photo + DXF (decided 2026-09-29) so pre-design drawers never land on an empty page.
- `viewOnly` keys off `locked` (stage ≥ in_production or cancelled), not `!editable` —
  pre-design drawers are non-editable too but have no layout to show.
- Nothing here changes a drawer's stage. Delivery is marked from the admin UI after merge.

## Validation gates

- G1 unit: `npm run test:labels` — Socket Drawer pixel corners ÷ 2048 match its
  `reference_corners` within 0.005; already-normalized `corner_points` → null; wrong photo size
  → null; missing/garbage → null; string-encoded JSON parses; `referenceCorners` unchanged.
- G3 static: `npm run typecheck`, `npm run build`, `npm run lint` clean; diff scoped to the
  four source files + test + this doc + package.json script.
- G4 browser (prod data, read-only, staff login): all 15 Weber-Ogden drawers — 9 with corner
  data overlay on the photo with no staff prompt, 6 without show photo + align prompt (customer:
  numbered plan); hover/click sync; locked drawer 080a22e8 shows the read-only layout;
  dashboard rows without DXF stay inert; 390px viewport; no console errors; label-entry
  regression on an unlocked designed drawer.
- G5 human: preview on a phone, then merge.

## After merge (admin UI)

1. Pipeline → select the 15 drawers → Mark delivered (jumps approved → delivered directly).
2. Order 25a8fb38: align the 6 un-cornered drawers as staff (drag TL/TR/BR/BL → Save).
3. Send the customer app.thetidytool.com.

# Feature spec — Approval changelog (design history & audit trail)

**Status:** Proposed · **Owner:** Sam · **Date:** 2026-06-28
**Builds on:** the shipped design-approval feature (`docs/approve/`, `drawer` approval columns,
`submit_drawer_approval` RPC). See `planning/FEATURE-profiles.md` and `planning/BACKEND-analysis.md`.

## Goal

Replace the current "columns overwrite on every action" model with an **append-only event log**
per drawer, so we can see the full history of a design: every change request, every approval,
and **every update to the design image**. Today, reopening or re-approving a drawer overwrites
`approved_by` / `approved_at` / `approval_note` and the preview file is upserted in place — so
history is lost. This feature keeps it.

## Decisions (2026-06-28)

- **Audience:** both — the customer sees their own design's history on the approve page, and the
  data backbone supports a staff view across drawers.
- **Image history:** keep **every revision**. Each uploaded preview is stored at a versioned path
  so the exact image at each point stays viewable.
- **Staff view:** not built now. Build the *backbone* (table + RPC) so a staff dashboard can be
  dropped in later with no schema change.

## What gets logged

Four event types, append-only:

| event_type | when | actor |
|---|---|---|
| `design_uploaded` | first preview attached to a drawer | staff (you, via the script) |
| `design_revised` | a new preview replaces the prior one | staff |
| `approved` | customer signs off | customer |
| `changes_requested` | customer asks for changes (with note) | customer |

Each event snapshots the `preview_url` (and optionally `dxf_url`) in effect at that moment, plus a
`revision` number, so the changelog can show *which image* was approved or rejected.

## Data model

New append-only table:

```sql
create table public.drawer_event (
  id          uuid primary key default gen_random_uuid(),
  drawer_id   uuid not null references public.drawer(id) on delete cascade,
  revision    int,                       -- design revision this event relates to
  event_type  text not null check (event_type in
                 ('design_uploaded','design_revised','approved','changes_requested')),
  actor_name  text,                      -- customer's typed name, or a staff label
  actor_role  text not null check (actor_role in ('customer','staff')),
  note        text,                      -- change-request text or revision note
  preview_url text,                      -- snapshot of the design image at this event
  dxf_url     text,                      -- snapshot of the CAD file at this event
  created_at  timestamptz not null default now()
);
create index drawer_event_drawer_created_idx on public.drawer_event (drawer_id, created_at desc);
```

Add one convenience column to `drawer` (the latest-state columns already exist and stay as a cache):

```sql
alter table public.drawer add column if not exists current_revision int not null default 0;
```

## RPC changes

All writes stay behind `SECURITY DEFINER` functions — the table itself has no direct
anon/authenticated write access (same pattern as the existing approval feature).

1. **`submit_drawer_approval` (modify).** After updating the drawer's latest-state columns, also
   `insert` a `drawer_event` row for the `approved` / `changes_requested` action — capturing
   `actor_name`, `actor_role='customer'`, `note`, the current `preview_url`/`dxf_url`, and
   `current_revision`. Keeps today's behavior (blocks duplicate approval; a change request reopens
   an approved design).

2. **`log_design_revision(p_drawer_id, p_preview_url, p_dxf_url, p_note)` (new, staff only).**
   Bumps `current_revision`, updates `drawer.design_preview_url`/`dxf_url`, **resets
   `customer_approval_status` to `pending`** (a new image needs re-approval), and inserts a
   `design_uploaded` (rev 1) or `design_revised` event with `actor_role='staff'`. Optionally fires
   the Discord webhook ("New design ready for review"). `EXECUTE` granted to `service_role` only —
   called by `tools/make_preview.py`, never the website.

3. **`get_drawer_changelog(p_drawer_id)` (new).** `SECURITY DEFINER`, returns the events for one
   drawer (newest first) with display-safe fields. `EXECUTE` to `anon` — token-gated by the
   drawer `id`, same trust model as the approval page. (A separate `get_recent_events()` admin RPC
   can come later with the staff view.)

## Storage versioning

`tools/make_preview.py` currently upserts to a single path (`approvals/{drawer_id}.png`), which
overwrites old images. Change it to write a **versioned path**:

```
approvals/{drawer_id}/rev-{n}.png
```

so each revision's image persists. The script computes the next revision, uploads there, then calls
`log_design_revision` with that permanent URL. (Bucket stays public-read.)

## Frontend — customer history on the approve page

Add a collapsible **"History"** section to `docs/approve/index.html` (shown on the review form and
the decided screens). On load it calls `get_drawer_changelog(id)` and renders a simple timeline:

```
Jun 28, 2026 · Approved — Jordan Smith
Jun 27, 2026 · Changes requested — Jordan Smith
              "Move the torque wrench pocket left."
Jun 27, 2026 · Design updated (rev 2)        [view image]
Jun 25, 2026 · Design uploaded (rev 1)       [view image]
```

Each entry shows the date, a friendly type label, who, any note, and a link/thumbnail to that
revision's image. Vanilla JS, same styling and `fetch` + anon-key approach as the rest of the page.

## Staff view — deferred, backbone ready

Not built now. When wanted, the `drawer_event` table + a `get_recent_events()` admin RPC make a
**live artifact dashboard** (reopenable, pulls fresh from Supabase) a ~half-day add: a sortable list
of recent activity across drawers, filterable by status, each row linking to the drawer's approve
page. No schema change required to add it.

## RLS & security

- Enable RLS on `drawer_event`; **no** direct select/insert/update/delete policies for
  `anon`/`authenticated`. The table is reachable only through the `SECURITY DEFINER` RPCs.
- **Append-only by construction:** the RPCs only ever `INSERT`; there is no UPDATE/DELETE path
  anywhere, so events can't be altered or removed via the API.
- `get_drawer_changelog` returns only display-safe columns.
- `log_design_revision` restricted to `service_role`; `EXECUTE` revoked from `anon`/`authenticated`.

## Migration & backfill

- **One migration:** create `drawer_event` + index, add `drawer.current_revision`, recreate
  `submit_drawer_approval`, add `log_design_revision` + `get_drawer_changelog`, set grants.
- **Backfill (optional):** for drawers that already have a `design_preview_url`, insert a synthetic
  `design_uploaded` (rev 1) event so their history isn't blank. Seed a couple of events on the demo
  drawer (`7698c0de…`) for visual testing.

## Testing (run on a branch before merge — see BACKEND-analysis §5–6)

- Events are insert-only: direct UPDATE/DELETE as anon/authenticated denied; direct INSERT denied.
- `submit_drawer_approval` writes exactly one event per call and still enforces the approval rules.
- `log_design_revision` bumps the revision, resets status to `pending`, and is denied to anon.
- `get_drawer_changelog` returns the full, correctly ordered history for a drawer id.
- Smoke test the whole loop: upload rev 1 → approve → request changes → upload rev 2 → approve,
  and confirm the changelog shows all five events with the right images.

## Effort estimate

| Piece | Estimate |
|---|---|
| DB: table, RPCs, grants, migration | ~2–3 hrs |
| `make_preview.py`: versioned upload + revision logging | ~1 hr |
| Approve-page History UI | ~2–3 hrs |
| Tests + end-to-end verify | ~1–2 hrs |
| Backfill + demo seed | ~0.5 hr |
| **Total** | **~1 day** |
| Staff artifact dashboard (later, optional) | +~0.5 day |

## Sequencing

1. Apply the migration (table + RPCs + grants).
2. Update `make_preview.py` to version images and call `log_design_revision`.
3. Add the History section to the approve page.
4. Backfill + seed the demo drawer; verify the full loop; deploy (`git push`).

## Risks & notes

- **Storage growth:** every revision is kept (intended). Previews are ~110 KB; negligible for now,
  prunable later if needed.
- **History starts now:** actions taken before this ships aren't recoverable beyond the current
  `drawer` columns.
- **Public read by token:** the changelog exposes customer names/notes to anyone holding the link —
  the same trust model as the approval page itself. Acceptable; revisit if links are ever shared
  broadly.
- **Safer path:** per `BACKEND-analysis.md`, ideally build/validate this on a Supabase **branch**
  before merging to production. Fast-path on the current base is possible (as with v1) if preferred.

## Open questions

1. Discord ping on a new design revision upload (not just on approvals)? *(suggest yes)*
2. Snapshot the DXF per revision too, or just the PNG preview? *(suggest yes — cheap, completes the record)*

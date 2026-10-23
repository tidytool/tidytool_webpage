# Remote reconstruction contract (Option B, lane 0)

**Status:** Proposed — awaiting Sam's review · **Card:** Todoist `6hq6FjvcjFjVfXfv` (T2-L0)
**Umbrella:** Remote scanning on any iPhone — Bonnell pilot · **Gates:** lanes L1–L3
**Source:** claude.ai project doc `claude/remote-pilot-tidycam-build-plan-2026-10-20.md` §3. That doc
is not on disk; the card text is the authoritative scope for this contract.

This document is the contract that every Option B lane builds against. It covers:

- the `capture` table;
- the private `scan_frames` bucket;
- the queue RPCs: `claim_next_capture()`, `worker_heartbeat()` and the ones around them;
- the `drawer.capture_state` column;
- the capture state machine;
- the failure semantics, under which the customer sees **"Rescan needed"**.

**Nothing in this document has been applied.** Every SQL block is the **target shape** for the
migration lane to lift; none of it is a migration. That lane writes the real migration file under
`portal/supabase/migrations/` (rules: that folder's `README.md`). It is applied to dev first with
`tools/db_apply.py`; Sam applies it to prod.

How to read this document:

- **Card-mandated** items are fixed by the card.
- Where the card is silent, the doc makes a choice and marks it **Decision (proposed)**. Each one is
  also listed in §12, *Open questions for Sam*.
- Every "exists" claim cites the migration file that created the object.

---

## 1. The flow in one picture

```
 tidyCAM (iPhone, signed-in user)                 Supabase                          Mac mini worker (role 'worker')
 ───────────────────────────────                  ────────                          ───────────────────────────────
 1. capture_id := uuid v4 (client)
 2. upload frames ─────────────────────▶ scan_frames/<drawer_id>/<capture_id>/frames/frame_0001.jpg …
    + manifest.json (last)                (private bucket, owner-write, immutable)
 3. rpc create_capture(capture_id, …) ──▶ capture row  status=queued
                                          drawer.capture_state = 'queued'
                                                                    ◀───────── 4. rpc claim_next_capture(worker_id)
                                          status=processing                          (FOR UPDATE SKIP LOCKED)
                                          drawer.capture_state = 'processing'
                                                                    ◀───────── 5. download frames (authenticated storage API)
                                                                    ◀───────── 6. rpc worker_heartbeat(…) every 30 s
                                                                               7. reconstruct → model.usdz + ortho.png
                                          drawer-assets/<drawer_id>/orders/<order>/photo_<ms>.png  ◀── 8. upload outputs
                                          lidar_scans/<drawer_id>/orders/<order>/model_<ms>.usdz   ◀──
                                                                    ◀───────── 9. rpc complete_capture(…)  or  fail_capture(…)
                                          status=done   → drawer.capture_state='ready',
                                                          drawer.photo_url / point_cloud_url filled if empty
                                          status=failed → drawer.capture_state='rescan_needed'
 portal: customer sees "Processing scan" / "Rescan needed"; staff see the capture queue.
 tidyCAD: unchanged — reads drawer.photo_url (the ortho) exactly as it does today.
```

---

## 2. What exists today (grounding; nothing here changes)

| Fact | Where |
|---|---|
| `drawer.id uuid NOT NULL` has **no DB default**. Clients generate it (tidyCAM uses `Uuid().v4()`). | `20260628062931_remote_schema.sql` (drawer DDL) |
| `drawer.photo_url` is the **ortho render** (PNG) and `drawer.point_cloud_url` is the model (USDZ). Both hold public URLs. | `20260628062931_remote_schema.sql`; portal `src/components/LabelEditor.tsx` ("photo_url IS the ortho render") |
| Drawer RLS: the owner (`created_by = auth.uid()`) or an admin can select and update. Staff get additive select and update policies. | `20260628062931_remote_schema.sql` (`drawers select`, `drawers update`); `20260715191252_staff_role_drawer_access.sql` (`drawer_select_staff`, `drawer_update_staff`) |
| `is_admin()` reads `user_roles.role = 'admin'`. `is_staff()` is true for staff **or** admin. `user_roles.role` is checked to be one of `('admin','user','staff')`. | `20260628062931_remote_schema.sql`; `20260715191252_staff_role_drawer_access.sql` |
| Status lifecycle (details below this table) | `20260727100000_status_backbone.sql` |
| `status_event.field` is checked to be one of `('stage','state','override','schedule')`. `status_event.source` is checked to be one of `('tidycam','tidycad','portal','system','bridge','backfill')`. | `20260727100000_status_backbone.sql` |
| Customer visibility of a drawer is the `get_my_drawers()` join: own orders plus whole-organization. `_customer_can_see_drawer(uuid)` mirrors it, but it is **revoked from `authenticated`**, so it can only be used inside SECURITY DEFINER functions. | `20260706000000_portal_durable_model_and_admin.sql`; `20260803120000_customer_tool_labels.sql` |
| House pattern for a new table: RLS deny-all, SECURITY DEFINER RPCs only, `revoke … from public, anon`. | `20260803120000_customer_tool_labels.sql` (`drawer_label`) |
| Storage buckets (details below this table) | `20260703220000_baseline_storage_policies.sql`; `planning/TIDYCAM-launch-coordination.md` §2 |
| `drawer.capture_quality` is the **Phase 0 QC tag** (`clean`, `needed_rework`, `needed_revisit`) that staff set. It is **unrelated** to `capture_state` below, and nothing here touches it. | `20260721175633_phase0_capture_quality_baseline_instrumentation.sql`, `20260721175808_phase0_set_capture_quality_rpc.sql` |
| `drawer.claimed_by`, `drawer.claimed_at` and `claim_drawer()` are the **staff design-claim** feature. They are **unrelated** to `claim_next_capture()`, and nothing here touches them. | `20260812210000_drawer_claims_and_progress.sql` |
| `is_approved()` (the tidyCAM approval gate) is **not** in any migration yet. It exists only as a proposal. | `planning/TIDYCAM-launch-coordination.md` §1 |
| `drawer` is already in the `supabase_realtime` publication. | `20260727100000_status_backbone.sql` §3 comment |

Status lifecycle detail (`20260727100000_status_backbone.sql`):

- `drawer.stage` records progress only. `drawer.state` is the blocker axis: `active`, `on_hold`,
  `rework` or `cancelled`.
- Both are written through `set_drawer_stage` and `set_drawer_state`. Both RPCs are staff-only and
  idempotent via `p_idempotency_key`.
- Every change is evented by the internal `record_status_event()`.
- `status_def` holds the customer tracker steps 1–7.

Storage bucket detail (`20260703220000_baseline_storage_policies.sql`;
`planning/TIDYCAM-launch-coordination.md` §2):

- `drawer-assets` paths are `<drawer_uuid>/…`, with owner-scoped insert and update.
- `lidar_scans` paths are `<x>/orders/<y>/model_<z>`, with owner-scoped select, insert and update.
- The broad legacy `drawer-assets` policies still exist.
- Neither bucket is created in a migration. Both are public.

How the sibling repos touch these today. This is a read-only survey of the local checkouts on
2026-10-22: tidyCAM on `feature/release-1.7.1`, tidyCAD on `main`. §9 re-cites against `origin/main`
wherever it relies on one of these facts.

**tidyCAM** (Flutter plus native Swift):

- Signs in with the publishable key and `signInWithPassword`. It never uses the service role.
- Writes `drawer` rows: `order_id`, `nickname`, `photo_url`, `dimensions`, legacy `status`,
  `point_cloud_url` and `boundary_*`. It writes `id` and `created_by` on insert only.
- Uploads to `drawer-assets/<drawer_id>/orders/<order_id>/photo_<epochms>.png` and to
  `lidar_scans/<drawer_id>/orders/<order_id>/model_<epochms>.usdz` with `upsert:false`, and stores
  the public URL.
- Calls only one RPC, `record_scan_correction`. It never writes `stage` or `state`.
- On-device ortho is a square PNG, 2048 px by default.
- `reference_corners` are **normalized 0–1**, ordered TL, TR, BR, BL.

**tidyCAD** (Python):

- Reads the image via `photo_url`. There is no `ortho_url` column.
- Its photo cache is keyed on `sha1(host+path)` with the query string dropped, so it already
  tolerates signed URLs.
- Its model cache is keyed on **drawer_id only**, so a replaced `point_cloud_url` would not be
  re-downloaded.
- `dimensions.correction.corner_points` are **ortho-photo pixels** and are authoritative. When they
  are absent, tidyCAD uses `boundary_corners` or `reference_corners` (**normalized**), scaled to the
  loaded image.

The contract below is shaped so that **neither sibling repo needs a change for the existing on-device path**.

---

## 3. Data model

### 3.1 `capture` table

One row is one attempt by a customer or staff member to scan one drawer. A rescan is always a
**new row**; rows are never reused.

| Column | Type | Card | Meaning / rule |
|---|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | ✓ | **Supplied by tidyCAM** (uuid v4). Frames are uploaded under `<drawer_id>/<capture_id>/` *before* the row exists, the same pattern as `drawer.id`. The default exists only for staff or manual inserts made through RPCs. |
| `drawer_id` | `uuid not null` → `drawer(id) on delete cascade` | ✓ | The drawer this scan is for. The drawer row must already exist. |
| `created_by` | `uuid not null` | ✓ | `auth.uid()` of the caller of `create_capture`, set server-side. There is no FK, which mirrors `drawer.created_by`. |
| `source` | `text` ∈ `device`, `worker` | ✓ | **Where reconstruction runs.** `worker` means queued for the Mac mini. `device` means reconstructed on the phone (the existing LiDAR path) and recorded for history only: the row is created already `done` and is never claimed. **Decision (proposed)** on the meaning. |
| `frame_count` | `int not null` | ✓ | Number of image frames (`frames/frame_NNNN.{jpg,heic}`) uploaded, excluding sidecars. For `worker` it must be between 20 and 400 (**Decision (proposed)**). `create_capture` checks that this many frames actually exist in storage. |
| `status` | `text` ∈ `queued`, `processing`, `done`, `failed` | ✓ | See the state machine in §5. |
| `error` | `text` | ✓ | Null unless the capture is `failed` or a failure was retried. Format: `<error_code>: <detail>`, with `error_code` taken from §7.1. **Staff-facing only.** Enforced by a column-level grant (below): no client role can select `error`, `timings`, `worker_id`, `claimed_at`, `heartbeat_at` or the attempt columns. Staff read them through `get_capture_queue()`. |
| `ortho_url` | `text` | ✓ | Public URL of the ortho PNG in `drawer-assets` (§4.3). Required when `done`. |
| `model_url` | `text` | ✓ | Public URL of the USDZ in `lidar_scans` (§4.3). Nullable, because an ortho-only success is still `done`. |
| `worker_id` | `text` | ✓ | Stable worker name of the **current** claimant, e.g. `mini-1`. Null while `queued`; the history lives in `timings.attempts`. |
| `claimed_at` | `timestamptz` | ✓ | When the current claim began. Null while `queued`. |
| `timings` | `jsonb not null default '{}'` | ✓ | Shape in §3.2. |
| `attempt_count` | `int not null default 0` | proposed | Incremented by each claim. It is also the **fencing token** (§8) and never decreases. |
| `attempt_limit` | `int not null default 3` | proposed | The retry cap (§7.2). A staff requeue raises this value instead of resetting `attempt_count`, so the fence stays monotonic. |
| `heartbeat_at` | `timestamptz` | proposed | Time of the last `worker_heartbeat` for the current claim. Stale-claim detection uses it. |
| `created_at`, `updated_at` | `timestamptz not null default now()` | proposed | House convention. |
| `finished_at` | `timestamptz` | proposed | Set when the capture becomes `done` or `failed`. |

The proposed extras are the smallest set of operational columns the card's state machine needs: a
fence, a retry cap, liveness and timestamps. **Decision (proposed).**

```sql
-- TARGET SHAPE — not applied.
create table public.capture (
  id            uuid primary key default gen_random_uuid(),
  drawer_id     uuid not null references public.drawer(id) on delete cascade,
  created_by    uuid not null,
  source        text not null check (source in ('device','worker')),
  frame_count   int  not null check (frame_count >= 0),
  status        text not null default 'queued'
                check (status in ('queued','processing','done','failed')),
  error         text,
  ortho_url     text,
  model_url     text,
  worker_id     text,
  claimed_at    timestamptz,
  timings       jsonb not null default '{}'::jsonb,
  attempt_count int  not null default 0 check (attempt_count >= 0),
  attempt_limit int  not null default 3 check (attempt_limit >= 1),
  heartbeat_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz,
  check (status <> 'done'       or ortho_url is not null),
  check (status <> 'failed'     or error is not null),
  check (status <> 'processing' or (worker_id is not null and claimed_at is not null)),
  check (source = 'worker'      or status = 'done')          -- device rows are history only
);

create index capture_queue_idx      on public.capture (created_at)   where status = 'queued';
create index capture_processing_idx on public.capture (heartbeat_at) where status = 'processing';
create index capture_drawer_idx     on public.capture (drawer_id, created_at desc);

alter table public.capture enable row level security;
revoke all on table public.capture from public, anon, authenticated;
-- Column-level grant: the client-facing columns only. error, timings, worker_id, claimed_at,
-- heartbeat_at, attempt_count, attempt_limit stay unreadable to every client role (staff included —
-- staff read them through the SECURITY DEFINER get_capture_queue()). Clients must name columns:
-- PostgREST `select=*` on capture fails with 42501 by design.
grant select (id, drawer_id, created_by, source, frame_count, status,
              ortho_url, model_url, created_at, updated_at, finished_at)
  on table public.capture to authenticated;
-- Row filter: the creator (tidyCAM shows its own uploads) and staff. Customers who did not create
-- the capture read status through get_my_capture_status() (§6) — _customer_can_see_drawer() is not
-- granted to authenticated, so it cannot appear in a policy.
create policy capture_select on public.capture
  for select to authenticated
  using (created_by = auth.uid() or public.is_staff());
-- No INSERT / UPDATE / DELETE policies: every write goes through the §6 RPCs. Client-facing RPCs
-- return the same narrowed column set, never the full row (§6).
```

### 3.2 `capture.timings` shape

```jsonc
{
  "client":   { "capture_s": 41.2, "upload_s": 18.7, "bytes": 182334112,
                "device": "iPhone15,2", "app_version": "1.9.0" },            // from create_capture
  "worker":   { "download_s": 6.1, "reconstruct_s": 212.4, "ortho_s": 3.3,
                "upload_s": 2.0, "total_s": 224.9, "detail": "medium",
                "ortho_px": 2048, "host": "tidy-mini", "version": "0.3.0" },  // last attempt, from complete/fail
  "attempts": [                                                               // server-appended, never client-written
    { "attempt": 1, "worker_id": "mini-1", "claimed_at": "…", "ended_at": "…",
      "outcome": "lost", "error_code": "worker_lost" },
    { "attempt": 2, "worker_id": "mini-1", "claimed_at": "…", "ended_at": "…", "outcome": "done" }
  ]
}
```

The server owns `attempts`. A caller's `p_timings` is stored under `client` when it comes from
`create_capture`, and under `worker` when it comes from `complete_capture` or `fail_capture`. A
caller therefore can never overwrite the audit trail. Queue wait is derived as
`claimed_at − created_at` and is not stored.

### 3.3 `capture_worker` table (backs `worker_heartbeat`)

**Decision (proposed).** The card names `worker_heartbeat` but does not say where liveness is
stored. A table with one row per worker lets the admin queue show "worker offline" even when no
capture is processing. With a single unattended Mac mini, that is the most likely failure mode.

```sql
-- TARGET SHAPE — not applied.
create table public.capture_worker (
  worker_id          text primary key check (worker_id ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  auth_user_id       uuid not null,                 -- the worker account that last beat
  version            text,
  current_capture_id uuid references public.capture(id) on delete set null,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now()
);
alter table public.capture_worker enable row level security;
revoke all on table public.capture_worker from public, anon, authenticated;  -- read via get_capture_queue()
```

### 3.4 `drawer` columns: `capture_state`, `current_capture_id`

`capture_state` is a **new axis on the drawer, not a tracker stage**:

- It is not added to `status_def` or `status_transition`.
- It never changes `stage`, `state` or `order.computed_status`. There is one proposed exception, in §5.3.
- The customer tracker steps stay 1–7 as they are.

| `drawer.capture_state` | Set when the drawer's **current** capture becomes… | Customer copy (portal) |
|---|---|---|
| `null` | Never had a remote capture (every drawer today) | (unchanged UI) |
| `queued` | `queued` (including after an automatic retry) | "Processing scan" |
| `processing` | `processing` | "Processing scan" |
| `ready` | `done` | (no chip; the normal drawer card) |
| `rescan_needed` | `failed` | **"Rescan needed"** |

`current_capture_id` points at the drawer's latest capture, and `create_capture` sets it. Only the
capture it points at may move `capture_state` or fill `photo_url` and `point_cloud_url`. A
superseded capture that finishes late changes nothing on the drawer (§5.2).

**Decision (proposed):** use an explicit pointer instead of "latest by `created_at`", so that
ordering never depends on clock or insert timing.

```sql
-- TARGET SHAPE — not applied. Nullable, no default ⇒ metadata-only change, no table rewrite.
alter table public.drawer
  add column capture_state      text check (capture_state in ('queued','processing','ready','rescan_needed')),
  add column current_capture_id uuid references public.capture(id) on delete set null;

comment on column public.drawer.capture_state is
  'Remote-reconstruction status of the drawer''s current capture (planning/remote-reconstruction-contract.md). '
  'NOT a lifecycle stage. RPC-managed only; never write directly. Unrelated to capture_quality (Phase 0 QC tag).';
```

**RPC-only write, enforced.** CLAUDE.md rule 2 says status columns are written only by RPCs. The
existing drawer UPDATE policies let the owner and staff write *any* column, so a guard trigger is
needed to enforce the rule for this column:

- The capture RPCs set a transaction-local flag before they write.
- Like the `status_event` immutability note, this guards the application path. It is not a
  security boundary against the table owner or service_role.

**Decision (proposed).**

```sql
-- TARGET SHAPE — not applied.
create or replace function public.drawer_capture_state_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('tidytool.capture_write', true), '') = 'on' then
    return new;
  end if;
  -- FK action: deleting a capture row directly (retention purge, dashboard cleanup) fires the
  -- `on delete set null` RI update on drawer.current_capture_id from inside a trigger
  -- (pg_trigger_depth() > 1). Allow exactly that — pointer nulled, nothing else touched — and
  -- clear capture_state with it: a drawer with no current capture has no capture state.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and old.current_capture_id is not null and new.current_capture_id is null
     and new.capture_state is not distinct from old.capture_state then
    new.capture_state := null;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.capture_state is not null or new.current_capture_id is not null then
      raise exception 'drawer.capture_state is RPC-managed' using errcode = '42501';
    end if;
  elsif new.capture_state      is distinct from old.capture_state
     or new.current_capture_id is distinct from old.current_capture_id then
    raise exception 'drawer.capture_state is RPC-managed (use the capture RPCs)' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger drawer_capture_state_guard
  before insert or update of capture_state, current_capture_id on public.drawer
  for each row execute function public.drawer_capture_state_guard();
```

tidyCAM's existing drawer insert and update never send these columns, so the guard never fires on
its path. The same is true of tidyCAD's update and insert.

The FK-action exception has two limits:

- It only ever *clears* the pointer. It cannot set one, and it cannot set a state.
- The two FKs form a cycle: `capture.drawer_id → drawer` cascades, while
  `drawer.current_capture_id → capture` sets null.

The migration lane must therefore prove two deletes on dev: deleting a drawer that has captures
(the admin bulk-delete path), and deleting a capture row directly. Both are in the §10 checklist.

### 3.5 The worker identity: `user_roles.role = 'worker'`, `is_worker()`

**Decision (proposed).** The Mac mini signs in as a **dedicated Supabase auth user**, one per
environment (for example `worker@thetidytool.com`), with `user_roles.role = 'worker'`. It does
**not** use the service-role key.

Why:

- The service-role key bypasses all RLS on all tables, from an unattended box.
- A role-scoped user can reach only the worker RPCs and the storage prefixes in §4.

The rejected alternative was keeping the service-role key in the worker's keychain. It is simpler,
but its blast radius is the largest possible.

`is_worker()` is **not** folded into `is_staff()`. The worker cannot read the drawer, order or
customer tables. It sees only what the RPCs hand it.

```sql
-- TARGET SHAPE — not applied. Widening a CHECK is expand-only.
alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role = any (array['admin','user','staff','worker']::text[]));

create or replace function public.is_worker()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles
                  where user_id = auth.uid() and role = 'worker');
$$;
revoke all on function public.is_worker() from public, anon;
grant execute on function public.is_worker() to authenticated, service_role;
```

---

## 4. Storage

### 4.1 `scan_frames` bucket (new, private)

| Property | Value |
|---|---|
| id / name | `scan_frames` |
| public | **false**. No public URLs ever exist for frames. |
| file_size_limit | 25 MB per object (**Decision (proposed)**) |
| allowed_mime_types | `image/jpeg`, `image/heic`, `application/json` |
| created by | The lane's migration (`insert into storage.buckets … on conflict do nothing`), so that dev and test branches replay it. Today's buckets were created in the dashboard, which is a known gap (`migrations/README.md`, "Known gaps"). **Decision (proposed).** |

**Path convention.** Everything is stored under the drawer, then the capture:

```
scan_frames/
  <drawer_id>/<capture_id>/manifest.json            ← written LAST by tidyCAM, before create_capture
  <drawer_id>/<capture_id>/frames/frame_0001.jpg    ← 4-digit, 1-based, contiguous (jpg or heic)
  <drawer_id>/<capture_id>/frames/frame_0001.json   ← optional per-frame sidecar (intrinsics/pose/exposure)
  …
```

- Both ids are lowercase uuid v4. tidyCAM's `Uuid().v4()` already emits lowercase.
- `manifest.json` (**Decision (proposed)**) has a minimal shape: `{ "capture_id", "drawer_id",
  "frame_count", "frames": ["frames/frame_0001.jpg", …], "device", "ios_version", "app_version",
  "has_depth": false }`.
- The worker treats a mismatch between the manifest and the listing as `insufficient_frames` (§7.1).
- Objects are **immutable**: no client role has UPDATE or DELETE.
- **The prefix is open for writing only before `create_capture`.** The insert policy (§4.2) rejects
  an object in either of two cases:
  - its `<capture_id>` already has a `capture` row;
  - any object under the same `<drawer_id>/<capture_id>/` prefix is owned by someone else, so the
    first uploader owns the prefix.

  Consequences:
  - Another member of the same organization cannot inject frames into a capture.
  - Nobody can add frames after the capture is queued.
- **Uploads use `upsert:false`.** A `409 Duplicate` *before* `create_capture` means the object is
  already uploaded, and counts as success. That makes the upload phase idempotent. *After*
  `create_capture`, uploads under that prefix are refused, whether the response is 403/RLS or 409.
  tidyCAM must finish every upload, the manifest included, before calling `create_capture`. A
  refused upload for an already-created capture is a client bug, not a retry case.

### 4.2 Who can read and write each prefix

| Prefix | tidyCAM user (drawer owner, customer of the drawer, or staff) | Worker (`is_worker()`) | Staff / admin (portal) | anon |
|---|---|---|---|---|
| `scan_frames/<drawer_id>/<capture_id>/…` | **Insert only**, as `owner = auth.uid()`. Allowed only when all three hold: `_can_capture_drawer(drawer_id)` (§6.1); no `capture` row exists yet for `capture_id`; the caller owns every object already under that prefix. Select only its own objects, to resume an upload. | Select (download) all | Select all (signed-URL preview, §4.4) | None |
| `drawer-assets/<drawer_id>/orders/<order_id\|unassigned>/photo_<ms>.png` | Unchanged (today's policies) | Insert as owner (already allowed by `drawer_assets_insert`) | Unchanged | Read through the public URL (unchanged) |
| `lidar_scans/<drawer_id>/orders/<order_id\|unassigned>/model_<ms>.usdz` | Unchanged | Insert as owner (already allowed by "Allow authenticated uploads to lidar_scans") | Unchanged | Read through the public URL (unchanged) |

```sql
-- TARGET SHAPE — not applied.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scan_frames', 'scan_frames', false, 26214400,
        array['image/jpeg','image/heic','application/json'])
on conflict (id) do nothing;

-- Path helper: casts the path segments safely (Postgres does not guarantee AND
-- short-circuit, so the casts must not live in the policy expression itself).
create or replace function public._can_capture_drawer_path(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_drawer uuid; v_capture uuid; v_prefix text;
begin
  begin
    v_drawer  := split_part(p_name, '/', 1)::uuid;
    v_capture := split_part(p_name, '/', 2)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  v_prefix := v_drawer::text || '/' || v_capture::text || '/';
  return public._can_capture_drawer(v_drawer)
     -- closed once queued: no frames can be added after create_capture
     and not exists (select 1 from public.capture c where c.id = v_capture)
     -- first uploader owns the prefix: nobody else can inject frames into it
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'scan_frames'
                        and left(o.name, length(v_prefix)) = v_prefix
                        and o.owner is distinct from auth.uid());
end $$;
revoke all on function public._can_capture_drawer_path(text) from public, anon;
grant execute on function public._can_capture_drawer_path(text) to authenticated;   -- needed inside the policy

create policy scan_frames_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'scan_frames'
    and owner = auth.uid()
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(manifest\.json|frames/frame_[0-9]{4}\.(jpg|heic|json))$'
    and public._can_capture_drawer_path(name)
  );

create policy scan_frames_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'scan_frames'
    and (owner = auth.uid() or public.is_staff() or public.is_worker())
  );
-- Deliberately NO update/delete policies on scan_frames for any client role.
```

This contract does **not** modify the existing `drawer-assets` or `lidar_scans` policies. The
storage tightening in `TIDYCAM-launch-coordination.md` §2 stays independent of it. The worker keeps
working after that tightening, because it uploads as owner under a uuid-prefixed path.

### 4.3 Outputs go where on-device outputs already go

**Decision (proposed).** The worker publishes outputs **byte-for-byte in the on-device
convention**. The portal, tidyCAD and the QR pages then cannot tell a remote scan from an on-device
scan.

- **Ortho:** a square PNG, 2048 px by default, framed the same way as tidyCAM's on-device ortho
  (top-down orthographic, drawer centred, following the `dimensions.ortho_view` convention). It is
  written to `drawer-assets/<drawer_id>/orders/<order_id>/photo_<epochms>.png`.
- **Model:** a USDZ, written to `lidar_scans/<drawer_id>/orders/<order_id>/model_<epochms>.usdz`.
- **Missing order:** when `drawer.order_id` is null the path uses `unassigned` in place of the
  order id. This keeps the `lidar_scans` path regex satisfied.
- **URLs:** the worker stores `getPublicUrl(...)` strings, the same as tidyCAM does today.
  `capture.ortho_url` and `capture.model_url` hold those same strings.
  `complete_capture` copies them to `drawer.photo_url` and `drawer.point_cloud_url` **only if those
  are empty** (§5.2).
- **Timestamped paths, never overwritten:** every attempt writes new object names. An attempt that
  loses its claim leaves orphaned objects behind, never a corrupted current file. Cleaning up
  orphans is out of scope (§11).

### 4.4 Signed URLs

- `scan_frames` is private.
  - The worker downloads frames with its authenticated session through the storage API
    (`download(path)`), not through signed URLs.
  - If a staff frame preview is built in the portal, the server mints
    `createSignedUrl(path, 600)` at render time.
- **The database never stores a signed URL.** It stores object paths, or public URLs for the public
  output buckets.
- **Any cache must key on the object path** (`bucket + name`), **never on the full URL.** The
  `?token=` changes every time a URL is signed (CLAUDE.md gotcha). tidyCAD's photo cache already
  does this; anything new must too.

---

## 5. State machine

### 5.1 `capture.status`

```
 create_capture(source=worker)                                     create_capture(source=device)
            │                                                                   │
            ▼                 claim_next_capture                                ▼
       ┌─────────┐  ─────────────────────────────────▶  ┌────────────┐  complete_capture  ┌──────┐
       │ queued  │                                      │ processing │ ─────────────────▶ │ done │  (terminal)
       └─────────┘  ◀─────────────────────────────────  └────────────┘                    └──────┘
          │   ▲        retry: fail_capture(retryable) /        │
          │   │        reaper (attempts left) /                │ fail_capture(final) / reaper(exhausted) /
          │   │        requeue_capture (staff)                 │ cancel_capture (staff)
          │   │                                                ▼
          │   │  requeue_capture (staff)              ┌──────────────┐
          │   └────────────────────────────────────── │    failed    │  (terminal unless staff requeue)
          └──────────────────────────────────────────▶└──────────────┘
             superseded by a newer create_capture / cancel_capture (staff)
```

The transition table is normative. No other transition is legal, and only the named RPCs perform these transitions.

| # | From → To | Performed by | Caller | `drawer.capture_state` (current capture only) |
|---|---|---|---|---|
| T1 | — → `queued` | `create_capture(source='worker')` | tidyCAM user / staff | `queued` |
| T2 | — → `done` | `create_capture(source='device')` | tidyCAM user / staff | `ready` |
| T3 | `queued` → `processing` | `claim_next_capture` | worker | `processing` |
| T4 | `processing` → `done` | `complete_capture` (live claim only) | worker | `ready`; `photo_url` and `point_cloud_url` are filled only if empty (§5.2) |
| T5 | `processing` → `queued` | `fail_capture` with a retryable code and attempts left | worker | `queued` |
| T6 | `processing` → `failed` | `fail_capture` with a non-retryable code, or with no attempts left | worker | `rescan_needed` |
| T7 | `processing` → `queued` | Reaper (§7.2) with attempts left | system, inside a worker's claim | `queued` |
| T8 | `processing` → `failed` | Reaper with no attempts left (`retries_exhausted`) | system | `rescan_needed` |
| T9 | `queued` → `failed` | `create_capture` for the same drawer (`superseded`) | tidyCAM user / staff | Unchanged (the old capture is no longer current) |
| T10 | `queued`/`processing` → `failed` | `cancel_capture` | staff | `rescan_needed` |
| T11 | `failed`/`processing` → `queued` | `requeue_capture` (current capture only; raises `attempt_limit`) | staff | `queued` |

`done` is terminal. A different result always means a **new capture** (a rescan).

### 5.2 Drawer-side rules

1. **Only the current capture writes to the drawer.** A capture whose id is not
   `drawer.current_capture_id` may still reach `done` or `failed`, but it leaves `capture_state`,
   `photo_url` and `point_cloud_url` alone.
2. **Fill if empty, never overwrite.** `complete_capture` sets `photo_url` and `point_cloud_url`
   only when they are null. **Decision (proposed).** Three reasons:
   - **Corners are tied to the image they were picked on.** `dimensions.correction.corner_points`
     are ortho-photo **pixels**, and `reference_corners` / `boundary_corners` are **normalized**
     against the image they were tapped on. Swapping the image under them would silently corrupt
     both (CLAUDE.md gotcha).
   - **tidyCAD's model cache is keyed on drawer_id.** A replaced `point_cloud_url` would never be
     re-downloaded.
   - **The scan-correction contract says raw assets are never modified.**

   Consequence: a rescan of a drawer that already has a photo produces its result on the `capture`
   row, and the drawer still reads `ready`. Adopting that newer result is a staff decision; see §12 Q6.
3. **Capture transitions never touch `stage`, `state`, `status_event`, `drawer_event`,
   `capture_quality`, `claimed_by` or `order.*`.** The one exception is the §5.3 proposal.
   Failure in particular does **not** put the drawer `on_hold` or `rework`. "Rescan needed" lives
   only on `capture_state`.
4. **Customer display is derived, and a photo always wins.** **Decision (proposed), rule (b).**
   - **The rule:** the customer-facing chip ("Processing scan" or "Rescan needed") is shown only
     while `drawer.photo_url is null`. Once a drawer has a photo, its card is the normal drawer
     card, whatever `capture_state` says.
   - **Where it is computed:** server-side, once, as `display_state` in `get_my_capture_status()`
     (§6), so the portal and tidyCAM cannot drift apart.
   - **Why it is needed:** tidyCAM's on-device scan and rescan path writes `drawer.photo_url`
     directly and never touches `capture_state`. That is the `uploadReplacementAssets` →
     `from('drawer').update(...)` path in `lib/services/storage/supabase_order_service.dart`
     ≈l.278, on tidyCAM `feature/release-1.7.1`, not yet on tidyCAM main.
   - **What it fixes:** without this rule, a drawer at `rescan_needed` that is then rescanned on a
     LiDAR device would show "Rescan needed" next to a valid photo. A remote capture still
     `queued` when an on-device photo lands would show "Processing scan" the same way.
   - **No tidyCAM dependency:** the rule needs no tidyCAM change, and it also holds for app builds
     already in the field.
   - **Staff view is raw:** `capture_state` itself is not rewritten; it stays the truthful status
     of the last *capture*. Staff views show it unfiltered.
   - **Rejected alternative (a):** tidyCAM calls `create_capture(source='device')` for every
     on-device scan of a drawer whose `capture_state` is not null. It keeps `capture_state`
     current, but depends on every tidyCAM build doing so. It stays open for Sam as §12 Q2.

### 5.3 Relation to the tracker (`drawer.stage`)

A drawer row that tidyCAM inserts gets `stage = 'scanned'` from `drawer_stage_bridge`, as it does
today (`20260727100000_status_backbone.sql` §8). So a remotely scanned drawer already sits at
tracker step 2 while it is still reconstructing. The `capture_state` chip ("Processing scan" or
"Rescan needed") qualifies that step; no new step is added.

**Decision (proposed), needs Sam (§12 Q4):** if staff pre-created the drawer at `stage = 'backlog'`
and a customer then scans it remotely, `complete_capture` advances it `backlog → scanned`. That is
an existing sanctioned `advance` in `status_transition`. `stage` is never raw-updated (CLAUDE.md
rule 2), and `set_drawer_stage` is staff-only, so the worker cannot call it. That leaves two
compliant write paths, and Sam picks one.

**Option (b): reuse the existing legacy bridge.** No new stage writer.

- `complete_capture` writes the legacy ops field, and only when the drawer is still `backlog`:
  `update drawer set status = 'created_by_user' where id = … and stage = 'backlog'`.
- `drawer_stage_bridge` then does the rest. It is the same path tidyCAM's legacy `status` writes
  already take (`20260727100000_status_backbone.sql` l.471–479). The bridge:
  - maps the value to `scanned`;
  - accepts it only as an advance;
  - sets `stage`;
  - events it with `kind = 'bridge'`, `source = 'bridge'`, note `legacy drawer_status write`.
- **Pros:** no new SECURITY DEFINER stage writer, and no body replace of `record_status_event`.
- **Cons:**
  - The event is attributed through `record_status_event`'s existing `actor_role` case. The
    worker is neither admin nor staff, so the event reads `actor_role = 'customer'`, with the
    worker's uid and email.
  - The event carries no `capture_id` and no idempotency key. It is idempotent anyway, because
    the bridge ignores non-advances.
  - It writes the legacy `status` column, which ARCHITECTURE.md decision 3 calls tidyCAM's ops
    field.

**Option (a): a dedicated internal RPC.** `complete_capture` calls one new internal SECURITY
DEFINER RPC, `_capture_advance_stage(p_drawer_id uuid, p_capture_id uuid)`. It is revoked from
`authenticated` and reachable only from `complete_capture`, and it mirrors `set_drawer_stage` step
for step:
  1. It locks the drawer `for update`.
  2. If the stage is not `backlog`, it returns (`p_expected_stage = 'backlog'` semantics).
  3. It requires that `status_transition` has the row (`drawer`, `backlog`, `scanned`) with kind
     `advance`.
  4. It sets `stage = 'scanned'` and mirrors legacy `status` via `map_stage_to_legacy`.
  5. It events the change with `record_status_event('drawer','stage','advance', …, p_source =>
     'system', p_idempotency_key => 'capture:<capture_id>:scanned')`. A key already present means
     return early.

  It is a set_drawer_stage-equivalent with exactly one hard-coded transition. It is not a
  general-purpose bypass.

  Attribution needs a body-only `create or replace` of `record_status_event` (same signature)
  adding `when public.is_worker() then 'worker'` to its `actor_role` case.

  - **Pros:** correct attribution, an idempotency key and a capture link in the event.
  - **Cons:** a second stage writer, and a body replace of a core function.

**Recommendation: (b) for the pilot.** It needs the smallest new surface and reuses an
already-reviewed path. Move to (a) if mis-attributed events matter in analytics.

If Sam declines both, the drawer stays in `backlog` until staff advance it, and nothing else in
this contract changes.

---

## 6. RPC surface

Every RPC is `security definer`, `set search_path = public`, `revoke … from public, anon`. Each is
granted to `authenticated` and does its own role check inside. Internal helpers (`_…`) are also
revoked from `authenticated`, except `_can_capture_drawer_path`, which storage RLS needs.

| RPC | Caller (checked inside) | Purpose | Idempotency |
|---|---|---|---|
| `create_capture(p_capture_id, p_drawer_id, p_frame_count, p_source default 'worker', p_ortho_url default null, p_model_url default null, p_timings default null) → table(capture_id, drawer_id, source, status, created_at)` | `_can_capture_drawer` (owner, customer of the drawer, or staff) | T1/T2. Verifies the frames are in storage. Device output URLs must live under the drawer's `drawer-assets` / `lidar_scans` prefixes. Supersedes a queued predecessor. Returns the **narrow** client shape, never the full row (no `error` or `timings`). | Replaying the same id returns the same row. |
| `claim_next_capture(p_worker_id) → table(capture_id, drawer_id, order_id, attempt, frame_count, frames_prefix, queued_at)` | `is_worker()` | Runs the reaper (§7.2), then T3. Returns 0 or 1 rows. `FOR UPDATE SKIP LOCKED`. | At most one claim per call. Two workers never get the same row. |
| `worker_heartbeat(p_worker_id, p_capture_id default null, p_attempt default null, p_version default null) → boolean` | `is_worker()` | Records liveness; bumps `capture.heartbeat_at` for a live claim. | Pure upsert. `false` means the claim is lost, so the worker must abort. |
| `complete_capture(p_capture_id, p_worker_id, p_attempt, p_ortho_url, p_model_url default null, p_timings default null) → capture` | `is_worker()` with the live claim | T4 plus the drawer writes. | Replaying the same attempt and `ortho_url` is a no-op. A stale fence raises `40001`. |
| `fail_capture(p_capture_id, p_worker_id, p_attempt, p_error_code, p_error default null, p_timings default null) → capture` | `is_worker()` with the live claim | T5/T6. The server decides retryability from the code (§7.1). | A stale fence is a no-op that returns the current row. |
| `requeue_capture(p_capture_id, p_reason) → capture` | `is_staff()` | T11. Allowed only for the drawer's current capture, with `source='worker'`. Sets `attempt_limit = attempt_count + 3`. | No-op if already `queued`. |
| `cancel_capture(p_capture_id, p_reason) → capture` | `is_staff()` | T10. `error = 'cancelled: <reason>'`. | No-op if already `failed`. |
| `get_my_capture_status() → table(drawer_id, display_state, capture_updated_at)` | any signed-in user | Customer view, with the same visibility as `get_my_drawers()`. `display_state` follows §5.2 rule 4: `null` when `photo_url is not null`, `'processing'` for `queued`/`processing`, `'rescan_needed'` for `rescan_needed`, otherwise `null`. Only rows with a non-null `display_state` are returned. No error text, no timings. | Read-only. |
| `get_capture_queue(p_include_done default false) → jsonb` | `is_staff()` | Admin view: `{workers:[{worker_id, version, last_seen_at, online, current_capture_id}], captures:[{capture_id, drawer_id, nickname, order_id, project_name, customer_name, status, source, attempt_count, attempt_limit, error, worker_id, claimed_at, heartbeat_at, created_at, finished_at, is_current, frame_count, timings}]}`. `online` means `last_seen_at > now() − 3 min`. | Read-only. |
| `_can_capture_drawer(uuid)`, `_can_capture_drawer_path(text)`, `_sync_drawer_capture_state(uuid)`, `_reap_stale_captures(text)`; `_capture_advance_stage(uuid, uuid)` only if §5.3 option (a) is chosen | internal | Helpers. | `_capture_advance_stage`: `status_event` idempotency key |

Why `get_my_capture_status()` is a new RPC: adding a column to `get_my_drawers()` would change its
return type, which needs a drop and recreate. That breaks in place, and it is the same "cannot
change return type" trap as `20260706000000`. A sibling RPC is expand-only. It mirrors
`get_my_label_status()` (`20260803120000_customer_tool_labels.sql`).

### 6.1 Target-shape SQL (not applied)

```sql
-- Who may start a capture for a drawer: staff, the drawer's creator, or a customer who can see it.
-- Cancelled drawers cannot be captured.
create or replace function public._can_capture_drawer(p_drawer_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.drawer d
     where d.id = p_drawer_id
       and d.state <> 'cancelled'
       and (public.is_staff()
            or d.created_by = auth.uid()
            or public._customer_can_see_drawer(d.id))
       -- AND public.is_approved()  ← add when the approval gate (TIDYCAM-launch-coordination §1) ships
  );
$$;

-- Mirror the current capture's status onto the drawer (no-op for a superseded capture).
create or replace function public._sync_drawer_capture_state(p_capture_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v public.capture;
begin
  select * into v from public.capture where id = p_capture_id;
  perform set_config('tidytool.capture_write', 'on', true);
  update public.drawer d
     set capture_state = case v.status when 'queued'     then 'queued'
                                       when 'processing' then 'processing'
                                       when 'done'       then 'ready'
                                       when 'failed'     then 'rescan_needed' end
   where d.id = v.drawer_id and d.current_capture_id = v.id;
  perform set_config('tidytool.capture_write', 'off', true);
end $$;

create or replace function public.create_capture(
  p_capture_id  uuid,
  p_drawer_id   uuid,
  p_frame_count int,
  p_source      text  default 'worker',
  p_ortho_url   text  default null,     -- source = 'device' only
  p_model_url   text  default null,     -- source = 'device' only
  p_timings     jsonb default null      -- stored under timings.client
) returns table (capture_id uuid, drawer_id uuid, source text, status text, created_at timestamptz)
  -- Narrow client shape (§3.1): never error / timings / worker columns.
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v       public.capture;
  v_prev  uuid;
  v_check uuid;
  v_tries int := 0;
  v_n     int;
begin
  if auth.uid() is null then
    raise exception 'sign-in required' using errcode = '42501';
  end if;

  -- Idempotent replay (tidyCAM retries after a timeout): same id => same row back.
  select * into v from public.capture c where c.id = p_capture_id;
  if found then
    if v.drawer_id <> p_drawer_id or v.created_by <> auth.uid() then
      raise exception 'capture id already in use' using errcode = '23505';
    end if;
    return query select v.id, v.drawer_id, v.source, v.status, v.created_at;
    return;
  end if;

  -- One error for "no such drawer" and "not yours" (anti-enumeration, like get_order_tracker).
  if not public._can_capture_drawer(p_drawer_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_source not in ('device','worker') then
    raise exception 'invalid source: %', p_source;
  end if;

  if p_source = 'worker' then
    if p_frame_count is null or p_frame_count not between 20 and 400 then
      raise exception 'frame_count must be 20..400 (got %)', p_frame_count;
    end if;
    -- The frames must already be in storage, uploaded by this caller (§4.1).
    select count(*) into v_n
      from storage.objects o
     where o.bucket_id = 'scan_frames'
       and o.owner = auth.uid()
       and o.name ~ ('^' || p_drawer_id::text || '/' || p_capture_id::text
                     || '/frames/frame_[0-9]{4}\.(jpg|heic)$');
    if v_n < p_frame_count then
      raise exception 'frames not uploaded: % of %', v_n, p_frame_count using errcode = 'P0001';
    end if;
  else
    -- Device outputs: same prefix checks as complete_capture (§4.3) — a caller cannot point a
    -- capture at another drawer's assets or an arbitrary URL.
    if p_ortho_url is null
       or strpos(p_ortho_url, '/drawer-assets/' || p_drawer_id::text || '/') = 0 then
      raise exception 'ortho_url must be a drawer-assets/<drawer_id>/ object';
    end if;
    if p_model_url is not null
       and strpos(p_model_url, '/lidar_scans/' || p_drawer_id::text || '/') = 0 then
      raise exception 'model_url must be a lidar_scans/<drawer_id>/ object';
    end if;
  end if;

  -- Lock order (§8): capture rows FIRST, then the drawer — the same order every other capture
  -- RPC uses (claim / complete / fail / reaper / requeue / cancel lock the capture, then touch the
  -- drawer). Read the pointer unlocked, lock the predecessor capture, lock the drawer, re-check.
  loop
    select d.current_capture_id into v_prev from public.drawer d where d.id = p_drawer_id;
    if v_prev is not null then
      perform 1 from public.capture c where c.id = v_prev for update;
    end if;
    select d.current_capture_id into v_check from public.drawer d where d.id = p_drawer_id for update;
    exit when v_check is not distinct from v_prev;
    v_tries := v_tries + 1;                        -- pointer moved underneath us: retry
    if v_tries >= 3 then
      raise exception 'drawer % busy, retry', p_drawer_id using errcode = '40001';
    end if;
  end loop;

  insert into public.capture (id, drawer_id, created_by, source, frame_count, status,
                              ortho_url, model_url, finished_at, timings)
  values (p_capture_id, p_drawer_id, auth.uid(), p_source, coalesce(p_frame_count, 0),
          case p_source when 'device' then 'done' else 'queued' end,
          case p_source when 'device' then p_ortho_url end,
          case p_source when 'device' then p_model_url end,
          case p_source when 'device' then now() end,
          jsonb_build_object('client', coalesce(p_timings, '{}'::jsonb)))
  returning * into v;

  -- A still-queued predecessor is superseded (saves worker time). A processing one may finish,
  -- but it no longer owns the drawer (§5.2 rule 1).
  if v_prev is not null then
    update public.capture c
       set status = 'failed', error = 'superseded: by capture ' || p_capture_id::text,
           finished_at = now(), updated_at = now()
     where c.id = v_prev and c.status = 'queued';
  end if;

  perform set_config('tidytool.capture_write', 'on', true);
  update public.drawer d
     set current_capture_id = v.id,
         capture_state      = case v.status when 'done' then 'ready' else 'queued' end
   where d.id = p_drawer_id;
  perform set_config('tidytool.capture_write', 'off', true);

  return query select v.id, v.drawer_id, v.source, v.status, v.created_at;
end $$;

create or replace function public.claim_next_capture(p_worker_id text)
returns table (capture_id uuid, drawer_id uuid, order_id uuid, attempt int,
               frame_count int, frames_prefix text, queued_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v public.capture;
begin
  if not public.is_worker() then
    raise exception 'worker role required' using errcode = '42501';
  end if;

  insert into public.capture_worker (worker_id, auth_user_id, last_seen_at)
  values (p_worker_id, auth.uid(), now())
  on conflict (worker_id) do update
     set auth_user_id = excluded.auth_user_id, last_seen_at = now();

  perform public._reap_stale_captures(p_worker_id);          -- §7.2

  select * into v
    from public.capture c
   where c.status = 'queued' and c.source = 'worker'
   order by c.created_at                                     -- FIFO
   limit 1
   for update skip locked;
  if not found then
    return;                                                  -- empty queue: worker sleeps and polls again
  end if;

  update public.capture c
     set status = 'processing', worker_id = p_worker_id,
         claimed_at = now(), heartbeat_at = now(),
         attempt_count = c.attempt_count + 1, updated_at = now()
   where c.id = v.id
  returning * into v;

  update public.capture_worker w set current_capture_id = v.id where w.worker_id = p_worker_id;
  perform public._sync_drawer_capture_state(v.id);

  return query
    select v.id, v.drawer_id, d.order_id, v.attempt_count, v.frame_count,
           v.drawer_id::text || '/' || v.id::text || '/', v.created_at
      from public.drawer d
     where d.id = v.drawer_id;
end $$;

create or replace function public.worker_heartbeat(
  p_worker_id  text,
  p_capture_id uuid default null,
  p_attempt    int  default null,
  p_version    text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_worker() then
    raise exception 'worker role required' using errcode = '42501';
  end if;

  insert into public.capture_worker (worker_id, auth_user_id, version, current_capture_id, last_seen_at)
  values (p_worker_id, auth.uid(), p_version, p_capture_id, now())
  on conflict (worker_id) do update
     set auth_user_id       = excluded.auth_user_id,
         version            = coalesce(excluded.version, public.capture_worker.version),
         current_capture_id = excluded.current_capture_id,
         last_seen_at       = now();

  if p_capture_id is null then
    return true;                                             -- idle beat
  end if;

  update public.capture
     set heartbeat_at = now(), updated_at = now()
   where id = p_capture_id and status = 'processing'
     and worker_id = p_worker_id and attempt_count = p_attempt;
  return found;                                              -- false => claim lost: abort, discard outputs
end $$;

create or replace function public.complete_capture(
  p_capture_id uuid, p_worker_id text, p_attempt int,
  p_ortho_url  text, p_model_url text default null, p_timings jsonb default null
) returns public.capture
language plpgsql security definer set search_path = public as $$
declare v public.capture;
begin
  if not public.is_worker() then
    raise exception 'worker role required' using errcode = '42501';
  end if;

  select * into v from public.capture where id = p_capture_id for update;
  if not found then
    raise exception 'capture not found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: this attempt already completed with this output.
  if v.status = 'done' and v.attempt_count = p_attempt and v.ortho_url = p_ortho_url then
    return v;
  end if;
  -- Fence (§8): only the live claim may complete.
  if v.status <> 'processing' or v.worker_id is distinct from p_worker_id
     or v.attempt_count <> p_attempt then
    raise exception 'lost claim on capture % (attempt %)', p_capture_id, p_attempt
      using errcode = '40001';
  end if;
  -- Outputs must live under this drawer in the on-device buckets (§4.3).
  if p_ortho_url is null
     or strpos(p_ortho_url, '/drawer-assets/' || v.drawer_id::text || '/') = 0 then
    raise exception 'ortho_url must be a drawer-assets/<drawer_id>/ object';
  end if;
  if p_model_url is not null
     and strpos(p_model_url, '/lidar_scans/' || v.drawer_id::text || '/') = 0 then
    raise exception 'model_url must be a lidar_scans/<drawer_id>/ object';
  end if;

  update public.capture c
     set status = 'done', ortho_url = p_ortho_url, model_url = p_model_url, error = null,
         finished_at = now(), heartbeat_at = now(), updated_at = now(),
         timings = jsonb_set(
           c.timings || jsonb_build_object('worker', coalesce(p_timings, '{}'::jsonb)),
           '{attempts}',
           coalesce(c.timings -> 'attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'attempt', c.attempt_count, 'worker_id', c.worker_id,
             'claimed_at', c.claimed_at, 'ended_at', now(), 'outcome', 'done')))
   where c.id = v.id
  returning * into v;

  -- Drawer: current capture only, fill-if-empty only (§5.2).
  perform set_config('tidytool.capture_write', 'on', true);
  update public.drawer d
     set photo_url       = coalesce(d.photo_url, v.ortho_url),
         point_cloud_url = coalesce(d.point_cloud_url, v.model_url),
         capture_state   = 'ready'
   where d.id = v.drawer_id and d.current_capture_id = v.id;
  perform set_config('tidytool.capture_write', 'off', true);

  -- §5.3 (proposed, pending Sam; current capture only). Option (b), recommended:
  --   update public.drawer set status = 'created_by_user'
  --    where id = v.drawer_id and stage = 'backlog';            -- drawer_stage_bridge advances + events it
  -- Option (a):
  --   perform public._capture_advance_stage(v.drawer_id, v.id);   -- backlog → scanned, evented, idempotent

  update public.capture_worker w
     set current_capture_id = null, last_seen_at = now()
   where w.worker_id = p_worker_id;
  return v;
end $$;

create or replace function public.fail_capture(
  p_capture_id uuid, p_worker_id text, p_attempt int,
  p_error_code text, p_error text default null, p_timings jsonb default null
) returns public.capture
language plpgsql security definer set search_path = public as $$
declare
  v         public.capture;
  v_retry   boolean;
  v_final   boolean;
begin
  if not public.is_worker() then
    raise exception 'worker role required' using errcode = '42501';
  end if;
  -- Worker-reportable codes and their retryability (§7.1). The server decides, not the caller.
  v_retry := case p_error_code
               when 'insufficient_frames'   then false
               when 'bad_frames'            then false
               when 'reconstruction_failed' then false
               when 'ortho_failed'          then false
               when 'download_failed'       then true
               when 'upload_failed'         then true
               when 'worker_error'          then true
             end;
  if v_retry is null then
    raise exception 'unknown error_code: %', p_error_code;
  end if;

  select * into v from public.capture where id = p_capture_id for update;
  if not found then
    raise exception 'capture not found' using errcode = 'P0002';
  end if;
  -- Stale fence => no-op: the attempt is over either way (reaped, requeued, cancelled).
  if v.status <> 'processing' or v.worker_id is distinct from p_worker_id
     or v.attempt_count <> p_attempt then
    return v;
  end if;

  v_final := not v_retry or v.attempt_count >= v.attempt_limit;

  update public.capture c
     set status      = case when v_final then 'failed' else 'queued' end,
         error       = case when v_final and v_retry then 'retries_exhausted: ' else '' end
                       || p_error_code || ': ' || left(coalesce(p_error, ''), 2000),
         finished_at = case when v_final then now() end,
         worker_id = null, claimed_at = null, heartbeat_at = null, updated_at = now(),
         timings = jsonb_set(
           c.timings || jsonb_build_object('worker', coalesce(p_timings, '{}'::jsonb)),
           '{attempts}',
           coalesce(c.timings -> 'attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'attempt', c.attempt_count, 'worker_id', c.worker_id, 'claimed_at', c.claimed_at,
             'ended_at', now(), 'outcome', case when v_final then 'failed' else 'retry' end,
             'error_code', p_error_code)))
   where c.id = v.id
  returning * into v;

  perform public._sync_drawer_capture_state(v.id);
  update public.capture_worker w
     set current_capture_id = null, last_seen_at = now()
   where w.worker_id = p_worker_id;
  return v;
end $$;

-- Stale-claim recovery (§7.2). Runs at the top of every claim_next_capture; no cron needed.
create or replace function public._reap_stale_captures(p_worker_id text)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_exhausted boolean; v_code text;
begin
  for r in
    select c.* from public.capture c
     where c.status = 'processing'
       and (c.worker_id = p_worker_id                          -- this worker restarted mid-capture
            or c.heartbeat_at < now() - interval '3 minutes'   -- ~6 missed beats
            or c.claimed_at   < now() - interval '45 minutes') -- hard wall-clock cap
     for update skip locked
  loop
    v_exhausted := r.attempt_count >= r.attempt_limit;
    v_code := case when r.claimed_at < now() - interval '45 minutes' then 'timeout' else 'worker_lost' end;
    update public.capture c
       set status      = case when v_exhausted then 'failed' else 'queued' end,
           error       = case when v_exhausted
                              then 'retries_exhausted: ' || v_code || ': attempt ' || r.attempt_count
                                   || ' on ' || r.worker_id
                              else c.error end,
           finished_at = case when v_exhausted then now() end,
           worker_id = null, claimed_at = null, heartbeat_at = null, updated_at = now(),
           timings = jsonb_set(c.timings, '{attempts}',
             coalesce(c.timings -> 'attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
               'attempt', r.attempt_count, 'worker_id', r.worker_id, 'claimed_at', r.claimed_at,
               'ended_at', now(), 'outcome', 'lost', 'error_code', v_code)))
     where c.id = r.id;
    perform public._sync_drawer_capture_state(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Grants (house posture).
revoke all on function public._can_capture_drawer(uuid)             from public, anon, authenticated;
revoke all on function public._sync_drawer_capture_state(uuid)      from public, anon, authenticated;
revoke all on function public._reap_stale_captures(text)            from public, anon, authenticated;
revoke all on function public.create_capture(uuid,uuid,int,text,text,text,jsonb)   from public, anon;
revoke all on function public.claim_next_capture(text)                             from public, anon;
revoke all on function public.worker_heartbeat(text,uuid,int,text)                 from public, anon;
revoke all on function public.complete_capture(uuid,text,int,text,text,jsonb)      from public, anon;
revoke all on function public.fail_capture(uuid,text,int,text,text,jsonb)          from public, anon;
grant execute on function public.create_capture(uuid,uuid,int,text,text,text,jsonb) to authenticated;
grant execute on function public.claim_next_capture(text)                           to authenticated;
grant execute on function public.worker_heartbeat(text,uuid,int,text)               to authenticated;
grant execute on function public.complete_capture(uuid,text,int,text,text,jsonb)    to authenticated;
grant execute on function public.fail_capture(uuid,text,int,text,text,jsonb)        to authenticated;
-- requeue_capture / cancel_capture / get_my_capture_status / get_capture_queue: same posture.
```

`requeue_capture`, `cancel_capture`, `get_my_capture_status` and `get_capture_queue` are fully
specified by the table above and §7. Their bodies follow the existing patterns:

- the `is_staff()` guard from `set_drawer_state`;
- the customer join from `get_my_label_status()`;
- the `jsonb` rollup from `get_status_pipeline()`.

The migration lane writes them in those patterns.

---

## 7. Failure semantics

### 7.1 Error codes

The format is `capture.error = '<code>: <detail>'`. Customers never see the code or the detail.
Every `failed` capture, whatever the code, shows the customer **"Rescan needed"** (§12 Q3).

| Code | Assigned by | Retryable | Meaning |
|---|---|---|---|
| `insufficient_frames` | worker | no | Fewer usable frames than the manifest or minimum; manifest/listing mismatch. |
| `bad_frames` | worker | no | Frames unreadable, or failing the worker's quality gate (blur, exposure). |
| `reconstruction_failed` | worker | no | Photogrammetry produced no usable model (e.g., not enough overlap). |
| `ortho_failed` | worker | no | Model built, but no drawer plane or ortho could be derived. |
| `download_failed` | worker | yes | Could not fetch frames from `scan_frames`. |
| `upload_failed` | worker | yes | Could not upload outputs to `drawer-assets` or `lidar_scans`. |
| `worker_error` | worker | yes | Unexpected crash or exception, including OOM. |
| `worker_lost` | server (reaper) | yes | Heartbeat older than 3 min, or the same worker re-claimed after a restart. |
| `timeout` | server (reaper) | yes | Claimed more than 45 min ago, regardless of heartbeats. |
| `retries_exhausted` | server | final | Prefix added when a retryable failure hits `attempt_limit`. |
| `superseded` | server (`create_capture`) | final | A newer capture for the same drawer arrived while this one was still `queued`. |
| `cancelled` | staff (`cancel_capture`) | final | Staff stopped it, with a reason. |

**Decision (proposed):** the server, not the caller, decides retryability. Input problems are
final at once, because retrying the same frames cannot help. Infrastructure problems retry.

### 7.2 Stale claims, retry cap and timings

| Parameter | Value (**Decision (proposed)**) |
|---|---|
| Worker poll interval when the queue is empty | 10 s (`claim_next_capture`) |
| Heartbeat while processing | every 30 s (`worker_heartbeat` with `p_capture_id`, `p_attempt`) |
| Heartbeat while idle | every 60 s (`worker_heartbeat` without a capture) |
| Stale claim | `heartbeat_at` older than **3 min** |
| Hard wall-clock cap | `claimed_at` older than **45 min** |
| Retry cap | `attempt_limit = 3` claims per capture (staff requeue adds 3) |
| Worker shown offline in admin | `capture_worker.last_seen_at` older than 3 min |

**Recovery runs lazily inside `claim_next_capture`** (`_reap_stale_captures`). There is no pg_cron
dependency.

- **What it reaps:** a stale or over-cap `processing` row goes back to `queued` if attempts remain.
  Otherwise it becomes `failed` (`retries_exhausted`).
- **Worker restarts:** a worker that restarts and claims again also reaps anything still held under
  its own `worker_id`. A crash mid-capture therefore costs one attempt, not a 3-minute wait.
- **Rule for that to be safe:** one `worker_id` must equal exactly one worker process. Two
  concurrent processes on the Mac mini need two ids (`mini-1`, `mini-2`).
- **No worker running:** nothing is reaped, and nothing could be processed anyway. The admin queue
  shows the worker as offline, and the processing row's heartbeat age shows it is stuck. Staff can
  `requeue_capture` or `cancel_capture`.

### 7.3 What each party sees

| Party | `queued` / `processing` | `done` | `failed` |
|---|---|---|---|
| Customer (portal) — chips only while `photo_url is null` (§5.2 rule 4) | chip **"Processing scan"** | no chip, normal drawer card | chip **"Rescan needed"**, sub-copy: *"We couldn't build a usable scan of this drawer. Open tidyCAM and scan it again."* |
| tidyCAM user | own capture row: status | own row: `done` | own row: `failed`, and a "Rescan" action on the drawer |
| Staff (portal admin) | queue row: age, attempt n/limit, worker, heartbeat age | row with outputs | row with `error`, plus **Requeue** / **Cancel** |
| tidyCAD | nothing new (drawer not yet usable: `photo_url` null) | `photo_url` / `point_cloud_url` as today | nothing new |

Notification on the transition to `rescan_needed`, by email or the existing Discord channel, is out
of scope here. The transition is the hook to attach it to (§11).

---

## 8. Idempotency and fencing

| Operation | Why a retry is safe |
|---|---|
| Frame upload | Names are immutable, uploads use `upsert:false`, and `409 Duplicate` means done. No client role can update or delete. |
| `create_capture` | The client supplies `capture_id`, and a replay returns the same row. Reusing an id for another drawer or user gives `23505`. Two concurrent first calls race on the PK: the loser gets `23505` and its retry returns the row. |
| `claim_next_capture` | `FOR UPDATE SKIP LOCKED` hands each queued row to exactly one caller. A worker that crashes after claiming loses that attempt (reaped on its next claim). The row is never processed twice concurrently. |
| `worker_heartbeat` | Upsert. The boolean result is the worker's only "keep going" signal. |
| `complete_capture` | Fenced by `(worker_id, attempt_count)`. A replay of the same attempt and `ortho_url` returns the row. A stale fence raises `40001`, and the worker discards its result; its timestamped uploads are harmless orphans. |
| `fail_capture` | A stale fence is a no-op. |
| Drawer writes | Fill-if-empty, plus the `current_capture_id` pointer, means a replay or late finisher cannot double-apply or clobber anything. |
| `requeue_capture` / `cancel_capture` | No-op if the capture is already in the target state. |
| §5.3 stage advance (if accepted) | `set_drawer_stage`-style idempotency key `capture:<id>:scanned` in `status_event`. |

**The fence is `attempt_count`.** Each claim increments it, and nothing ever decrements it. A staff
requeue raises `attempt_limit` instead of resetting the count. A zombie worker still holding
attempt *n* therefore cannot complete a capture that has since been reclaimed as attempt *n+1*,
even if both claims carry the same `worker_id`.

**Lock order: capture rows before the drawer row, always.**

- These RPCs lock the `capture` row first and then write the drawer, in `_sync_drawer_capture_state`
  or the output fill: `claim_next_capture`, `complete_capture`, `fail_capture`,
  `_reap_stale_captures`, `requeue_capture` and `cancel_capture`.
- `create_capture` follows the same order. It reads `current_capture_id` unlocked, locks that
  predecessor capture, then locks the drawer, and re-checks the pointer. It retries up to 3 times,
  then raises `40001` (§6.1).
- The worker's heartbeat touches only `capture`.
- tidyCAM's and tidyCAD's own drawer updates lock only the drawer.

With one global order, a `40P01` deadlock should not occur between capture RPCs. As a belt and
braces rule, every client treats `40001` and `40P01` from any capture RPC as **retryable**. A
retry with the same arguments is safe by the rows above.

---

## 9. Consumers

### 9.1 tidyCAM iOS app — uploads frames, creates the capture

Everything below is **new L-lane work** unless it carries a citation. Today, on tidyCAM
`origin/main` (`lib/services/storage/supabase_order_service.dart`), tidyCAM does three things:

- inserts and updates `drawer` rows directly;
- uploads to `drawer-assets` (l.485) and `lidar_scans` (l.532) under
  `<drawer_id>/orders/<order_id>/…`;
- stores `getPublicUrl` (l.803).

It does **not** call `get_my_drawers()` and has no capture code.

- **Role:** `authenticated`, signed in with the publishable key, as today. The user may be a
  customer (remote pilot) or staff.
- **Writes (new):**
  - Storage `scan_frames/<drawer_id>/<capture_id>/…`, insert only, `upsert:false`. All uploads,
    the manifest included, finish *before* `create_capture`; `409` counts as success only in that
    phase (§4.1).
  - RPC `create_capture`.
  - Never `capture` rows or `drawer.capture_state` directly; the guard trigger rejects that.
- **Reads (new):**
  - Its own `capture` rows. RLS is `created_by = auth.uid()`, and the grant is column-level, so
    columns must be named; `select=*` is refused (§3.1).
  - `get_my_capture_status()` for the customer-facing `display_state`.
  - Staff builds may read `drawer.capture_state` from their drawer `select()`. Model decoding must
    tolerate the new keys.
- **Pilot customers on staff-created drawers.** Drawer RLS (`drawers select`,
  `20260628062931_remote_schema.sql`) does not let a customer select a drawer they did not create.
  Listing such drawers is **new L1 work**, through `get_my_drawers()`
  (`20260706000000_portal_durable_model_and_admin.sql`), which tidyCAM does not call today (§12 Q10).
- **Sequence (new):**
  1. The drawer row exists. tidyCAM creates it as today (client-generated `drawer.id`,
     `photo_url` null), or staff pre-created it.
  2. Generate `capture_id` (uuid v4).
  3. Upload the frames, then the sidecars, then `manifest.json` last.
  4. Call `create_capture(capture_id, drawer_id, frame_count, 'worker', p_timings => {capture_s, upload_s, bytes, device, app_version})`.
  5. Show status from `get_my_capture_status()`. Realtime on `drawer` is optional; `drawer` is
     already published (`20260727100000_status_backbone.sql`).
- **For a remote capture, leave `photo_url` and `point_cloud_url` empty.** The worker fills them.
- **On-device path:** unchanged, and it does **not** create captures (§5.2 rule 4, §12 Q2). An
  on-device scan or rescan writes `photo_url` directly, as it does today. The customer chip then
  disappears because a photo exists.
- **On "Rescan needed",** offer a rescan of the same drawer. That means a new `capture_id` and a
  new upload; the old capture is never reused.

### 9.2 Reconstruction worker (Mac mini) — claims, heartbeats, writes results

- **Role:** a dedicated auth user with `user_roles.role = 'worker'` (§3.5), using the publishable
  key. Credentials live in the macOS keychain, never in a repo or `.env` that is committed. One
  user per environment (dev `gfkrebuioszsxanjdnsx`, prod `tkrrvpoupekrjqditupi`).
- **Reads:**
  - the `claim_next_capture` result;
  - `scan_frames` objects under `frames_prefix` (authenticated `download`, and `list` for
    validation).
  - It reads **no tables**.
- **Writes:**
  - outputs to `drawer-assets` and `lidar_scans` (§4.3: timestamped names, `upsert:false`, public
    URL);
  - `worker_heartbeat`, `complete_capture` and `fail_capture`.
- **Loop:**
  1. Claim. If the queue is empty, sleep 10 s.
  2. Fetch the manifest and validate it against the listing. On a mismatch, report
     `fail_capture('insufficient_frames')`.
  3. Start a 30 s heartbeat. If a beat returns `false`, abort immediately and discard.
  4. Reconstruct. `timings.json` becomes `p_timings`.
     - **Nothing here is on any main branch yet.** A `tidycam-worker` CLI that writes
       `model.usdz`, `ortho.png` and `timings.json` exists only on the **unmerged** tidyCAM branch
       `agent/6hq8P84Xx6XWVPh6-worker-core`.
     - That CLI has **no** claim loop, heartbeat or bucket I/O. Every step of this loop is new
       worker-lane work.
  5. Upload the outputs.
  6. Call `complete_capture`. A `40001` response means log and drop.
  7. On any exception, call `fail_capture` with the closest §7.1 code. `worker_error` is the
     catch-all.
- **Must:**
  - keep ortho parity with on-device (square PNG, 2048 px default, same framing);
  - give every process a unique `worker_id`;
  - send idle heartbeats;
  - clean local scratch per capture.

### 9.3 Portal — customer status, admin queue

- **Role:** `authenticated` for customers; staff and admin via `is_staff()`.
- **Customer** (`src/app/page.tsx`, which already batches `get_my_drawers()` at l.254): add
  `get_my_capture_status()` to the same `Promise.all`, which is new work. Render a `.chip` on each
  drawer card from `display_state`:
  - "Processing scan" for `processing`;
  - **"Rescan needed"** for `rescan_needed`, plus the §7.3 sub-copy.

  The RPC already applies the photo-wins rule (§5.2 rule 4), so the portal must **not** re-derive
  it from `capture_state`. `get_my_drawers()`, `get_order_tracker()` and the 7-step tracker are
  untouched.
- **Admin:** a capture queue view, either a new admin route or a section of `/admin/queue`. It is
  fed by `get_capture_queue()` and shows worker online/offline, the queue, processing (with
  heartbeat age) and failures with `error`.
  - **Requeue** and **Cancel** call `requeue_capture` and `cancel_capture` from server actions,
    using the existing `useTransition` + `router.refresh()` pattern.
  - An optional frame preview mints `createSignedUrl` server-side per render, with no URL
    persisted or cached (§4.4).
- **Roles UI: a required code change, which must ship *before* the worker user exists.**
  - **The problem:** `src/components/EmployeesList.tsx` derives `isAdmin` and `isStaff` from
    `user.roles` (l.73–74). It offers **Grant staff** (l.211) and **Make admin** (l.219) to any
    user who is neither. A `worker`-only user would therefore be one click away from staff or
    admin.
  - **The change:**
    - Add an `isWorker = user.roles.includes("worker")` badge.
    - Hide every grant/revoke/make-admin action for worker users.
    - Make the server actions behind those buttons refuse a target that holds `worker`.
  - **Who manages the role:** Sam only, outside the UI (§10).

### 9.4 tidyCAD — consumes the ortho and model output

- **No change required to consume outputs.** tidyCAD reads `drawer.photo_url` (the ortho) and
  `drawer.point_cloud_url` (USDZ) exactly as it does today, so a completed remote capture is
  indistinguishable from an on-device scan.
  - Its photo cache keys on a sha1 of the URL without its query (`tidytool/services/photo_cache.py`
    l.51, on `origin/main`).
  - The one required change is the Select guard below.
- **Corner coordinates.** The worker writes **no** corners, calibration or dimensions.
  - Corners picked later on the worker's ortho are stored as usual. `correction.corner_points` are
    **ortho pixels**; `reference_corners` and `boundary_corners` are **normalized 0–1**, each
    relative to *that* ortho image.
  - They stay valid because `photo_url` is never replaced once set (§5.2 rule 2).
  - Ortho parity (square PNG, same framing as on-device) keeps tidyCAD's "normalized × loaded image
    size" scaling correct.
  - Do not mix the two coordinate spaces (CLAUDE.md gotcha).
- **Known caveat, pre-existing:** the model cache is keyed on `drawer_id`
  (`tidytool/services/lidar.py` l.91–93, on `origin/main`). This is harmless under
  never-overwrite, but it must be fixed (key on the object path) before any "adopt a newer capture"
  feature (§12 Q6).
- **Required coordinated follow-up (tidyCAD): guard Select.** A remote drawer sits at
  `stage = 'scanned'` from insert (§5.3) while `photo_url` is still null, whether it is processing
  or failed.
  - **The gap:** tidyCAD's work queue offers **Select** (`scanned → design_queue`) on any
    `scanned` row without checking for a photo. On tidyCAD `origin/main`,
    `tidytool/services/work_queue.py` defines `ALLOWED_STAGE_WRITES` at l.40–41 and
    `STAGE_ACTIONS["scanned"]` at l.62–65.
  - **Consequence:** an operator could pull a not-yet-reconstructed drawer into design.
  - **The fix:** hide or disable Select while `photo_url is null`. Optionally show
    `capture_state`, which staff can read on `drawer`.
  - **Interim:** until that ships, staff simply don't Select drawers without a photo. The DB is
    unaffected either way; this is a UI guard. `get_work_queue()` is not changed by this
    contract.

### 9.5 Public pages (`docs/` `/q/`, `/approve/`)

Untouched. They keep reading `photo_url` through their existing anon RPCs. A drawer whose remote
capture has not finished simply has no photo yet, which is today's behaviour for a drawer without a
photo.

---

## 10. Rollout — expand only

There is one additive migration, written by the migration lane per `migrations/README.md`
(header with what/why/rollback/verify; dev first via `db_apply.py --env dev`; prod by Sam):

1. Widen the `user_roles_role_check` constraint to accept `'worker'`, and add `is_worker()`.
2. Create `capture` and `capture_worker`, with their indexes and deny-all RLS (plus the
   `capture_select` policy).
3. Add `drawer.capture_state` and `drawer.current_capture_id`. Both are nullable with no default,
   so this is a metadata-only change. Add the guard trigger.
4. Create the `scan_frames` bucket, the two storage policies and `_can_capture_drawer_path`.
5. Add the RPCs and grants (§6).
6. *Only if Sam accepts §5.3*:
   - **Option (b):** the guarded legacy-`status` write in `complete_capture`. No other change.
   - **Option (a):** a body-only `create or replace` of `record_status_event` adding the `worker`
     actor role, plus the internal `_capture_advance_stage()` and its call from `complete_capture`.

What the migration leaves alone:

- No existing column is renamed or retyped.
- No existing RPC signature or return type changes.
- No existing policy changes.
- No backfill is needed: `capture_state is null` means "never remotely captured", which is true
  for every existing drawer.
- **The existing on-device-only path keeps working with zero changes.** That covers tidyCAM's
  drawer insert, upload and rescan writes, tidyCAD's design flow, and the portal as it is today.
  Using the remote path needs the new L-lane work in §9, plus the coordinated follow-ups in §13.

**Out-of-migration setup is Sam's job, on both dev and prod.** Creating an auth user and granting a
role is auth work, and auth is high-risk. Agents do not do it on either environment. Sam:

1. Creates the worker auth user. The email must **not** match any `customer.email`, or the
   `link_customer_on_auth` trigger (`20260704000000_durable_identity.sql` l.114–141) would link
   the worker to that customer on creation and on every sign-in. Use a dedicated address, such as
   `worker+<env>@thetidytool.com`, and check
   `select 1 from customer where lower(email) = lower('<addr>')` first.
2. Inserts `user_roles (user_id, 'worker')`. It must be the only role row for that user: never
   staff, admin or user.
3. Does this only **after** the §9.3 EmployeesList change has shipped. Until then the worker would
   be listed with Grant staff and Make admin buttons.
4. Stores the credentials in the Mac mini keychain.

**Rollback** (before any customer captures exist), in this order:

1. Drop the RPCs, the guard trigger, the two drawer columns, `capture_worker`, `capture`, and the
   storage policies.
2. Delete the empty `scan_frames` bucket.
3. Restore the old role check.

Once customer frames exist, deleting them is "deleting data", which is high-risk and Sam's call.

**Dev verification the migration lane must show** (SQL against dev; record in its `verification.md`):

- [ ] `create_capture` by a user who cannot see the drawer → `42501`; by its owner without frames
      → `P0001`; with frames → `queued`, and `drawer.capture_state = 'queued'`.
- [ ] `update drawer set capture_state = 'ready'` as owner or staff → `42501`. tidyCAM's normal
      drawer update payload still succeeds.
- [ ] Two sessions calling `claim_next_capture` concurrently get different rows (or one empty).
- [ ] Back-dating `heartbeat_at` by 4 min makes the next claim requeue the row and append an
      `attempts[]` entry. The third loss → `failed`, `retries_exhausted`, `rescan_needed`.
- [ ] `complete_capture` with an old attempt → `40001`. A replay of the live attempt returns the
      same row. A pre-set `photo_url` is not overwritten.
- [ ] A superseded queued capture → `failed`/`superseded`. A late-finishing superseded processing
      capture leaves the drawer alone.
- [ ] `get_my_capture_status()` returns only the caller's drawers. anon cannot read `scan_frames`.
      A customer cannot read another user's frames. The worker can read all.
- [ ] `select error, timings from capture` as the creator → `42501` (column grant). Selecting the
      named client columns works. `create_capture` returns only the narrow shape.
- [ ] A `scan_frames` upload after `create_capture` for that `capture_id` is refused. An upload by
      a second user under a prefix the first user already started is refused.
- [ ] `create_capture(source='device')` with an `ortho_url` outside
      `/drawer-assets/<drawer_id>/` → error.
- [ ] `get_my_capture_status()` returns `display_state = null` once `photo_url` is set, even with
      `capture_state = 'rescan_needed'`.
- [ ] Deleting a drawer that has captures (the admin bulk-delete path) succeeds. Deleting a capture
      row directly nulls `drawer.current_capture_id` and `capture_state` without a guard error.
- [ ] Concurrent `create_capture` (new capture on drawer D) and `complete_capture` (D's current
      capture) both finish with no `40P01`.
- [ ] Supabase security advisors show no new findings (all functions pin `search_path`).

Any change to names, shapes or semantics here is a **contract change**: amend this document first.
It matches `planning/*contract*.md` in `.claude/team.json` `contract_globs`, so it gets the Systems
Engineer review lens.

---

## 11. Out of scope (explicitly not decided here)

- **Data lifecycle:** frame retention and deletion (§12 Q8), and cleanup of orphaned output
  objects from lost attempts.
- **Notifications:** customer or Discord notifications on `rescan_needed` (the hook is the
  transition).
- **Adopting a newer capture:** the "adopt / promote" action for a rescan of a drawer that already
  has a photo (§12 Q6).
- **Scale and dimensions:** for remote captures (§12 Q11). The worker writes no
  `dimensions`, `calibration_matrix` or corners in v1.
- **Security work tracked elsewhere:** the tidyCAM approval gate (`is_approved()`) and the tightening
  of the existing `drawer-assets` and `lidar_scans` policies. Both live in
  `TIDYCAM-launch-coordination.md`.
- **The worker internals:** the reconstruction algorithm, quality thresholds and Mac mini ops
  (launchd, keychain, scratch disk).
- **UI design:** tidyCAM screens and portal layout beyond the contract-level copy in §7.3.
- **Throughput:** queue priorities and multi-worker scheduling beyond FIFO with SKIP LOCKED.

---

## 12. Open questions for Sam

Each question restates a **Decision (proposed)** above. The recommendation is what the contract
currently says.

1. **Worker identity** (§3.5): a dedicated `worker`-role auth user, or the service-role key on the
   Mac mini? *Recommendation: the role user, for its smaller blast radius.*
2. **On-device scans vs `capture_state`** (§3.1, §5.2 rule 4): this doc reads `source` as *where
   reconstruction ran*. An on-device scan or rescan writes `photo_url` directly and never touches
   `capture_state`.
   - **Proposed (rule b):** the customer chip is derived server-side and suppressed once
     `photo_url` exists. tidyCAM does **not** create `source='device'` captures in the pilot, and
     the `device` value stays reserved.
   - **Alternative (rule a):** tidyCAM *must* call `create_capture(source='device')` for every
     on-device scan of a drawer whose `capture_state` is not null. That keeps `capture_state`
     truthful, at the cost of a tidyCAM dependency and of old builds in the field.

   *Recommendation: (b).*
3. **Infra failures after retries** (§7.1): show the customer "Rescan needed" for
   `retries_exhausted` too, even though their frames may be fine? The alternative is to keep
   showing "Processing scan" and alert staff only. *Recommendation: show "Rescan needed"; it is
   simple and honest, and a staff requeue flips it back.*
4. **Tracker interplay** (§5.3): advance a pre-created `backlog` drawer to `scanned` on its first
   successful capture? If yes, by which path?
   - **(b) The existing `drawer_stage_bridge`:** a legacy `status = 'created_by_user'` write.
     There is no new stage writer, but the event is attributed as `customer` and carries no capture
     link.
   - **(a) A new internal `_capture_advance_stage()`,** plus a body-only change to
     `record_status_event` for a `worker` actor role. Attribution and idempotency key are correct,
     but it adds a second stage writer.

   *Recommendation: yes, via (b), for the pilot. Pairs with Q10.*
5. **Who may capture** (§6.1 `_can_capture_drawer`): staff, the drawer's creator, or any customer
   who can see it (whole organization). Should captures be blocked after design starts
   (`stage ≥ design_queue`)? *Recommendation: allow any non-cancelled drawer and let staff judge.*
6. **Rescan of a drawer that already has a photo** (§5.2): v1 never overwrites
   `photo_url` / `point_cloud_url`. Is a staff "adopt this capture" RPC needed for the pilot? It
   would also clear stale corners and needs tidyCAD's model-cache fix. *Recommendation: defer until
   the pilot shows a need.*
7. **Numbers** (§3.1, §4.1, §7.2): 20–400 frames, 25 MB per object, 30 s heartbeat, 3 min stale,
   45 min hard cap, 3 attempts. *Recommendation: confirm against `tidycam-worker` timings on the
   Mac mini before the migration lane freezes them.*
8. **Frame retention:** keep frames forever, or delete them N days after `done`? Deleting is
   high-risk and Sam's call. *Recommendation: keep through the pilot, then decide.*
9. **Bucket creation** (§4.1): in the migration (replayable on branches), or in the dashboard like
   the existing buckets? *Recommendation: in the migration.*
10. **Pilot drawer creation:** `drawer_insert_authenticated` lets a user insert drawers only into
    orders *they* created (`20260628062931_remote_schema.sql`). If Sam creates the Bonnell order,
    the customer's tidyCAM cannot add drawers to it.
    - Option (a): staff pre-create the drawers (stage `backlog`). The customer captures into them;
      `_can_capture_drawer` admits them via the org join. tidyCAM would list them through
      `get_my_drawers()`. That is new L1 work, because tidyCAM does not call that RPC today.
    - Option (b): a new create-drawer RPC, which is a separate card.

    *Recommendation: (a).*
11. **Scale and dimensions for remote captures:** without LiDAR, the worker's ortho has no metric
    scale, and v1 writes no `dimensions`. Who supplies width and height: the customer in tidyCAM,
    or staff in tidyCAD from a reference object? This is not part of this contract, but it blocks
    design for remote drawers.
12. **Approval gate timing:** when `is_approved()` ships, it becomes a conjunct in
    `_can_capture_drawer` and in the `scan_frames` insert path. Does the Bonnell pilot run before
    or after the gate lands?
13. **Who creates and administers the worker user** (§3.5, §10)? This doc assigns it to Sam on
    both environments, because it is auth work.
    - Creating the user includes a dedicated non-customer email, the sole `worker` role row, and
      keychain storage on the Mac mini.
    - Should rotating or revoking it (for example, if the Mac mini is lost) also be Sam-only? Is a
      runbook entry wanted?

    *Recommendation: Sam-only, plus a short runbook entry when the worker lane lands.*

The creator's visibility of `capture.error` is resolved, not open: no client role can read it
(§3.1 column grant), and staff see it only through `get_capture_queue()`.

---

## 13. Coordinated follow-up cards

These cards are outside this contract's lane but are needed for the remote path to be safe. Each
one should be carded and linked to the umbrella.

1. **portal: EmployeesList `worker` role** (§9.3).
   - Add a worker badge.
   - Hide Grant staff and Make admin for worker users.
   - Make the server actions refuse such targets.
   - **Must merge before Sam creates the worker user.**
2. **tidyCAD: guard Select on photo** (§9.4). Disable `scanned → design_queue` while `photo_url`
   is null, and optionally show `capture_state`.
3. **worker CLI: queue I/O** (§9.2). Add the claim loop, heartbeat thread, `scan_frames`
   download, output upload and `complete_capture`/`fail_capture` to the `tidycam-worker` work on
   tidyCAM `agent/6hq8P84Xx6XWVPh6-worker-core`. Today it is local-only.
4. **tidyCAM: remote capture plus listing of pre-created drawers** (§9.1). Upload, call
   `create_capture`, use `get_my_drawers()` / `get_my_capture_status()`, and tolerate column
   grants (no `select=*` on `capture`).
5. **tidyCAM: record on-device scans as captures.** Only if Sam picks rule (a) in Q2. Under the
   recommended rule (b), no tidyCAM change is needed for on-device rescans.
6. **Runbook: worker user lifecycle** (Q13). Cover creation, rotation and revocation, all done by
   Sam.

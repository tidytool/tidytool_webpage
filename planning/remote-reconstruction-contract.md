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

How the sibling repos touch these today (read-only survey of `tidyCAM` and `tidyCAD`, 2026-10-22).

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
| `error` | `text` | ✓ | Null unless the capture is `failed` or a failure was retried. Format: `<error_code>: <detail>`, with `error_code` taken from §7.1. **Staff-facing only**; customers never see it. |
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
grant select on table public.capture to authenticated;
-- Read: the creator (tidyCAM shows its own uploads) and staff. Customers who did not create the
-- capture read status through get_my_capture_status() (§6) — _customer_can_see_drawer() is not
-- granted to authenticated, so it cannot appear in a policy.
create policy capture_select on public.capture
  for select to authenticated
  using (created_by = auth.uid() or public.is_staff());
-- No INSERT / UPDATE / DELETE policies: every write goes through the §6 RPCs.
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
- Uploads use `upsert:false`. A `409 Duplicate` on retry means the object is already uploaded and
  counts as success, so upload is idempotent.

### 4.2 Who can read and write each prefix

| Prefix | tidyCAM user (drawer owner, customer of the drawer, or staff) | Worker (`is_worker()`) | Staff / admin (portal) | anon |
|---|---|---|---|---|
| `scan_frames/<drawer_id>/<capture_id>/…` | **Insert only**, as `owner = auth.uid()`, and only if `_can_capture_drawer(drawer_id)` (§6.1) holds. Select only its own objects, to resume an upload. | Select (download) all | Select all (signed-URL preview, §4.4) | None |
| `drawer-assets/<drawer_id>/orders/<order_id\|unassigned>/photo_<ms>.png` | Unchanged (today's policies) | Insert as owner (already allowed by `drawer_assets_insert`) | Unchanged | Read through the public URL (unchanged) |
| `lidar_scans/<drawer_id>/orders/<order_id\|unassigned>/model_<ms>.usdz` | Unchanged | Insert as owner (already allowed by "Allow authenticated uploads to lidar_scans") | Unchanged | Read through the public URL (unchanged) |

```sql
-- TARGET SHAPE — not applied.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scan_frames', 'scan_frames', false, 26214400,
        array['image/jpeg','image/heic','application/json'])
on conflict (id) do nothing;

-- Path helper: casts the first path segment safely (Postgres does not guarantee AND
-- short-circuit, so the cast must not live in the policy expression itself).
create or replace function public._can_capture_drawer_path(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_drawer uuid;
begin
  begin
    v_drawer := split_part(p_name, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return public._can_capture_drawer(v_drawer);
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

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

### 5.3 Relation to the tracker (`drawer.stage`)

A drawer row that tidyCAM inserts gets `stage = 'scanned'` from `drawer_stage_bridge`, as it does
today (`20260727100000_status_backbone.sql` §8). So a remotely scanned drawer already sits at
tracker step 2 while it is still reconstructing. The `capture_state` chip ("Processing scan" or
"Rescan needed") qualifies that step; no new step is added.

**Decision (proposed), needs Sam (§12 Q4):** if staff pre-created the drawer at `stage = 'backlog'`
and a customer then scans it remotely, `complete_capture` advances it `backlog → scanned`.

- This is an existing sanctioned `advance` in `status_transition`.
- It is evented through `record_status_event('drawer','stage','advance', …, source => 'system',
  idempotency_key => 'capture:<capture_id>:scanned')`.
- That requires a body-only `create or replace` of `record_status_event` (same signature) to add
  `when public.is_worker() then 'worker'` to its `actor_role` case. Otherwise the event would be
  attributed as `customer`.
- If Sam declines, the drawer stays in `backlog` until staff advance it, and nothing else in this
  contract changes.

---

## 6. RPC surface

Every RPC is `security definer`, `set search_path = public`, `revoke … from public, anon`. Each is
granted to `authenticated` and does its own role check inside. Internal helpers (`_…`) are also
revoked from `authenticated`, except `_can_capture_drawer_path`, which storage RLS needs.

| RPC | Caller (checked inside) | Purpose | Idempotency |
|---|---|---|---|
| `create_capture(p_capture_id, p_drawer_id, p_frame_count, p_source default 'worker', p_ortho_url default null, p_model_url default null, p_timings default null) → capture` | `_can_capture_drawer` (owner, customer of the drawer, or staff) | T1/T2. Verifies the frames are in storage. Supersedes a queued predecessor. | Replaying the same id returns the same row. |
| `claim_next_capture(p_worker_id) → table(capture_id, drawer_id, order_id, attempt, frame_count, frames_prefix, queued_at)` | `is_worker()` | Runs the reaper (§7.2), then T3. Returns 0 or 1 rows. `FOR UPDATE SKIP LOCKED`. | At most one claim per call. Two workers never get the same row. |
| `worker_heartbeat(p_worker_id, p_capture_id default null, p_attempt default null, p_version default null) → boolean` | `is_worker()` | Records liveness; bumps `capture.heartbeat_at` for a live claim. | Pure upsert. `false` means the claim is lost, so the worker must abort. |
| `complete_capture(p_capture_id, p_worker_id, p_attempt, p_ortho_url, p_model_url default null, p_timings default null) → capture` | `is_worker()` with the live claim | T4 plus the drawer writes. | Replaying the same attempt and `ortho_url` is a no-op. A stale fence raises `40001`. |
| `fail_capture(p_capture_id, p_worker_id, p_attempt, p_error_code, p_error default null, p_timings default null) → capture` | `is_worker()` with the live claim | T5/T6. The server decides retryability from the code (§7.1). | A stale fence is a no-op that returns the current row. |
| `requeue_capture(p_capture_id, p_reason) → capture` | `is_staff()` | T11. Allowed only for the drawer's current capture, with `source='worker'`. Sets `attempt_limit = attempt_count + 3`. | No-op if already `queued`. |
| `cancel_capture(p_capture_id, p_reason) → capture` | `is_staff()` | T10. `error = 'cancelled: <reason>'`. | No-op if already `failed`. |
| `get_my_capture_status() → table(drawer_id, capture_state, capture_id, capture_updated_at)` | any signed-in user | Customer view. Same visibility as `get_my_drawers()`. Only drawers with `capture_state is not null`. | Read-only. |
| `get_capture_queue(p_include_done default false) → jsonb` | `is_staff()` | Admin view: `{workers:[{worker_id, version, last_seen_at, online, current_capture_id}], captures:[{capture_id, drawer_id, nickname, order_id, project_name, customer_name, status, source, attempt_count, attempt_limit, error, worker_id, claimed_at, heartbeat_at, created_at, finished_at, is_current, frame_count, timings}]}`. `online` means `last_seen_at > now() − 3 min`. | Read-only. |
| `_can_capture_drawer(uuid)`, `_can_capture_drawer_path(text)`, `_sync_drawer_capture_state(uuid)`, `_reap_stale_captures(text)` | internal | Helpers. | — |

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
) returns public.capture
language plpgsql security definer set search_path = public as $$
declare
  v      public.capture;
  v_prev uuid;
  v_n    int;
begin
  if auth.uid() is null then
    raise exception 'sign-in required' using errcode = '42501';
  end if;

  -- Idempotent replay (tidyCAM retries after a timeout): same id => same row back.
  select * into v from public.capture where id = p_capture_id;
  if found then
    if v.drawer_id <> p_drawer_id or v.created_by <> auth.uid() then
      raise exception 'capture id already in use' using errcode = '23505';
    end if;
    return v;
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
  elsif p_ortho_url is null then
    raise exception 'device captures need ortho_url';
  end if;

  -- Serialise concurrent create_capture calls on the same drawer.
  select current_capture_id into v_prev from public.drawer where id = p_drawer_id for update;

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
    update public.capture
       set status = 'failed', error = 'superseded: by capture ' || p_capture_id::text,
           finished_at = now(), updated_at = now()
     where id = v_prev and status = 'queued';
  end if;

  perform set_config('tidytool.capture_write', 'on', true);
  update public.drawer
     set current_capture_id = v.id,
         capture_state      = case v.status when 'done' then 'ready' else 'queued' end
   where id = p_drawer_id;
  perform set_config('tidytool.capture_write', 'off', true);

  return v;
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

  -- §5.3 (proposed, pending Sam): if drawer.stage = 'backlog', advance to 'scanned' and event it
  -- with idempotency key 'capture:' || v.id || ':scanned'.

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
| Customer (portal) | chip **"Processing scan"** | no chip, normal drawer card | chip **"Rescan needed"**, sub-copy: *"We couldn't build a usable scan of this drawer. Open tidyCAM and scan it again."* |
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

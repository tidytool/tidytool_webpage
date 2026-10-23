-- ============================================================================
-- Remote reconstruction, lane 1 (Todoist 6hq6FjxP4V9rj3GM, Option B): the capture
-- queue schema. Implements planning/remote-reconstruction-contract.md (T2-L0,
-- PR #38) sections 3-8 and the section 10 rollout, with every "Decision
-- (proposed)" taken as recommended in section 12 (incl. Q4 option (b) and Q9).
--
--   1. user_roles: widen the role CHECK to accept 'worker'; add is_worker().
--   2. capture (one scan attempt) + capture_worker (worker liveness), RLS deny-all
--      except capture_select; column-level grant hides error/timings/worker
--      columns from every client role.
--   3. drawer.capture_state + drawer.current_capture_id (nullable, no default =>
--      metadata-only) and the guard trigger that makes them RPC-managed.
--   4. Private scan_frames bucket, its insert/select storage policies and the
--      _can_capture_drawer_path() helper. No update/delete policies.
--   5. RPCs: create_capture, claim_next_capture, worker_heartbeat,
--      complete_capture, fail_capture, requeue_capture, cancel_capture,
--      get_my_capture_status, get_capture_queue + internal helpers.
--   6. Section 5.3 option (b): complete_capture advances a pre-created 'backlog'
--      drawer to 'scanned' by the legacy status write that drawer_stage_bridge
--      already sanctions (no new stage writer, CLAUDE.md rule 2).
--   7. Section 3.5 invariant "the worker cannot read the drawer, order or customer
--      tables": RESTRICTIVE deny-worker policies on those three tables (additive;
--      no existing policy is changed).
--
-- Expand-only: nothing existing is renamed, retyped or dropped (the role CHECK is
-- replaced by a strictly wider one in the same transaction). No backfill: a null
-- capture_state means "never remotely captured", true for every drawer today.
-- Worker auth user + its user_roles row are created by Sam (auth work), after the
-- EmployeesList worker-role change ships (contract section 9.3 / 13.1).
--
-- ROLLBACK (only while no customer frames exist): drop the functions below, the
-- drawer_capture_state_guard trigger + function, the *_deny_worker policies, the
-- scan_frames_* storage policies, drawer.capture_state/current_capture_id,
-- capture_worker, capture; delete the empty scan_frames bucket; restore
-- user_roles_role_check to ('admin','user','staff').
-- VERIFY: python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
-- ============================================================================

-- 1. Worker identity ---------------------------------------------------------
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

-- 2. capture + capture_worker ------------------------------------------------
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
  check (source = 'worker'      or status = 'done')
);

comment on table public.capture is
  'One remote/on-device scan attempt of one drawer (planning/remote-reconstruction-contract.md). '
  'Written only through the capture RPCs. A rescan is always a new row.';

create index capture_queue_idx      on public.capture (created_at)   where status = 'queued';
create index capture_processing_idx on public.capture (heartbeat_at) where status = 'processing';
create index capture_drawer_idx     on public.capture (drawer_id, created_at desc);

alter table public.capture enable row level security;
revoke all on table public.capture from public, anon, authenticated;
-- Client-facing columns only: error, timings, worker_id, claimed_at, heartbeat_at,
-- attempt_count, attempt_limit stay unreadable to every client role (staff read them
-- through get_capture_queue()). PostgREST select=* on capture fails with 42501 by design.
grant select (id, drawer_id, created_by, source, frame_count, status,
              ortho_url, model_url, created_at, updated_at, finished_at)
  on table public.capture to authenticated;
create policy capture_select on public.capture
  for select to authenticated
  using (created_by = (select auth.uid()) or (select public.is_staff()));

create table public.capture_worker (
  worker_id          text primary key check (worker_id ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  auth_user_id       uuid not null,
  version            text,
  current_capture_id uuid references public.capture(id) on delete set null,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now()
);
alter table public.capture_worker enable row level security;
revoke all on table public.capture_worker from public, anon, authenticated;

-- 3. drawer columns + guard ---------------------------------------------------
alter table public.drawer
  add column capture_state      text check (capture_state in ('queued','processing','ready','rescan_needed')),
  add column current_capture_id uuid references public.capture(id) on delete set null;

comment on column public.drawer.capture_state is
  'Remote-reconstruction status of the drawer''s current capture (planning/remote-reconstruction-contract.md). '
  'NOT a lifecycle stage. RPC-managed only; never write directly. Unrelated to capture_quality (Phase 0 QC tag).';
comment on column public.drawer.current_capture_id is
  'The drawer''s latest capture (set by create_capture). Only this capture may move capture_state or fill photo_url/point_cloud_url.';

create or replace function public.drawer_capture_state_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('tidytool.capture_write', true), '') = 'on' then
    return new;
  end if;
  -- FK action: deleting a capture row fires the on-delete-set-null RI update on
  -- drawer.current_capture_id from inside a trigger. Allow exactly that and clear
  -- capture_state with it (no current capture => no capture state).
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
revoke all on function public.drawer_capture_state_guard() from public, anon, authenticated;

create trigger drawer_capture_state_guard
  before insert or update of capture_state, current_capture_id on public.drawer
  for each row execute function public.drawer_capture_state_guard();

-- 7. Worker sees no drawer / order / customer rows (section 3.5) ----------------
create policy drawer_deny_worker on public.drawer as restrictive
  for all to authenticated
  using (not (select public.is_worker())) with check (not (select public.is_worker()));
create policy order_deny_worker on public."order" as restrictive
  for all to authenticated
  using (not (select public.is_worker())) with check (not (select public.is_worker()));
create policy customer_deny_worker on public.customer as restrictive
  for all to authenticated
  using (not (select public.is_worker())) with check (not (select public.is_worker()));

-- 5a. Internal helpers --------------------------------------------------------
-- Who may start a capture: staff, the drawer's creator, or a customer who can see it.
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

-- 4. scan_frames bucket + storage policies --------------------------------------
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
grant execute on function public._can_capture_drawer_path(text) to authenticated;

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

-- 5b. RPCs ------------------------------------------------------------------------
create or replace function public.create_capture(
  p_capture_id  uuid,
  p_drawer_id   uuid,
  p_frame_count int,
  p_source      text  default 'worker',
  p_ortho_url   text  default null,
  p_model_url   text  default null,
  p_timings     jsonb default null
) returns table (capture_id uuid, drawer_id uuid, source text, status text, created_at timestamptz)
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

  -- One error for "no such drawer" and "not yours" (anti-enumeration).
  if not public._can_capture_drawer(p_drawer_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('device','worker') then
    raise exception 'invalid source: %', p_source;
  end if;

  if p_source = 'worker' then
    if p_frame_count is null or p_frame_count not between 20 and 400 then
      raise exception 'frame_count must be 20..400 (got %)', p_frame_count;
    end if;
    -- The frames must already be in storage, uploaded by this caller (section 4.1).
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
    -- Device outputs must live under this drawer in the on-device buckets (section 4.3).
    if p_ortho_url is null
       or strpos(p_ortho_url, '/drawer-assets/' || p_drawer_id::text || '/') = 0 then
      raise exception 'ortho_url must be a drawer-assets/<drawer_id>/ object';
    end if;
    if p_model_url is not null
       and strpos(p_model_url, '/lidar_scans/' || p_drawer_id::text || '/') = 0 then
      raise exception 'model_url must be a lidar_scans/<drawer_id>/ object';
    end if;
  end if;

  -- Lock order (section 8): capture rows FIRST, then the drawer.
  loop
    select d.current_capture_id into v_prev from public.drawer d where d.id = p_drawer_id;
    if v_prev is not null then
      perform 1 from public.capture c where c.id = v_prev for update;
    end if;
    select d.current_capture_id into v_check from public.drawer d where d.id = p_drawer_id for update;
    exit when v_check is not distinct from v_prev;
    v_tries := v_tries + 1;
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

  -- A still-queued predecessor is superseded; a processing one may finish but no
  -- longer owns the drawer (section 5.2 rule 1).
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

-- Stale-claim recovery (section 7.2). Runs at the top of every claim_next_capture.
create or replace function public._reap_stale_captures(p_worker_id text)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_exhausted boolean; v_code text;
begin
  for r in
    select c.* from public.capture c
     where c.status = 'processing'
       and (c.worker_id = p_worker_id
            or c.heartbeat_at < now() - interval '3 minutes'
            or c.claimed_at   < now() - interval '45 minutes')
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

  perform public._reap_stale_captures(p_worker_id);

  select * into v
    from public.capture c
   where c.status = 'queued' and c.source = 'worker'
   order by c.created_at
   limit 1
   for update skip locked;
  if not found then
    return;
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
    return true;
  end if;

  update public.capture
     set heartbeat_at = now(), updated_at = now()
   where id = p_capture_id and status = 'processing'
     and worker_id = p_worker_id and attempt_count = p_attempt;
  return found;
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
  -- Fence (section 8): only the live claim may complete.
  if v.status <> 'processing' or v.worker_id is distinct from p_worker_id
     or v.attempt_count <> p_attempt then
    raise exception 'lost claim on capture % (attempt %)', p_capture_id, p_attempt
      using errcode = '40001';
  end if;
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

  -- Drawer: current capture only, fill-if-empty only (section 5.2).
  perform set_config('tidytool.capture_write', 'on', true);
  update public.drawer d
     set photo_url       = coalesce(d.photo_url, v.ortho_url),
         point_cloud_url = coalesce(d.point_cloud_url, v.model_url),
         capture_state   = 'ready'
   where d.id = v.drawer_id and d.current_capture_id = v.id;
  perform set_config('tidytool.capture_write', 'off', true);

  -- Section 5.3 option (b): a pre-created 'backlog' drawer advances to 'scanned'
  -- through the existing drawer_stage_bridge (legacy status write; the bridge maps,
  -- accepts only an advance, sets stage and events it). Current capture only.
  update public.drawer d
     set status = 'created_by_user'
   where d.id = v.drawer_id and d.stage = 'backlog' and d.current_capture_id = v.id;

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
  -- Worker-reportable codes and their retryability (section 7.1). The server decides.
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
  -- Stale fence => no-op: the attempt is over either way.
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

-- T11: staff requeue of the drawer's current worker capture. Raises attempt_limit
-- (never resets attempt_count, so the fence stays monotonic). Audited in
-- timings.attempts with outcome 'requeued'.
create or replace function public.requeue_capture(p_capture_id uuid, p_reason text)
returns public.capture
language plpgsql security definer set search_path = public as $$
declare v public.capture; v_current uuid;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to requeue';
  end if;
  select * into v from public.capture where id = p_capture_id for update;
  if not found then
    raise exception 'capture not found' using errcode = 'P0002';
  end if;
  if v.status = 'queued' then
    return v;
  end if;
  if v.source <> 'worker' then
    raise exception 'only worker captures can be requeued';
  end if;
  if v.status not in ('failed','processing') then
    raise exception 'cannot requeue a % capture (done is terminal; rescan instead)', v.status;
  end if;
  select d.current_capture_id into v_current from public.drawer d where d.id = v.drawer_id;
  if v_current is distinct from v.id then
    raise exception 'only the drawer''s current capture can be requeued';
  end if;

  update public.capture c
     set status = 'queued', attempt_limit = c.attempt_count + 3, finished_at = null,
         worker_id = null, claimed_at = null, heartbeat_at = null, updated_at = now(),
         timings = jsonb_set(c.timings, '{attempts}',
           coalesce(c.timings -> 'attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'attempt', c.attempt_count, 'worker_id', c.worker_id, 'claimed_at', c.claimed_at,
             'ended_at', now(), 'outcome', 'requeued', 'by', auth.uid(),
             'reason', left(p_reason, 500))))
   where c.id = v.id
  returning * into v;

  perform public._sync_drawer_capture_state(v.id);
  return v;
end $$;

-- T10: staff cancel of a queued or processing capture.
create or replace function public.cancel_capture(p_capture_id uuid, p_reason text)
returns public.capture
language plpgsql security definer set search_path = public as $$
declare v public.capture;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to cancel';
  end if;
  select * into v from public.capture where id = p_capture_id for update;
  if not found then
    raise exception 'capture not found' using errcode = 'P0002';
  end if;
  if v.status = 'failed' then
    return v;
  end if;
  if v.status not in ('queued','processing') then
    raise exception 'cannot cancel a % capture', v.status;
  end if;

  update public.capture c
     set status = 'failed', error = 'cancelled: ' || left(p_reason, 2000),
         finished_at = now(), worker_id = null, claimed_at = null, heartbeat_at = null,
         updated_at = now(),
         timings = case when v.status = 'processing' then jsonb_set(c.timings, '{attempts}',
           coalesce(c.timings -> 'attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'attempt', c.attempt_count, 'worker_id', c.worker_id, 'claimed_at', c.claimed_at,
             'ended_at', now(), 'outcome', 'cancelled', 'by', auth.uid())))
           else c.timings end
   where c.id = v.id
  returning * into v;

  perform public._sync_drawer_capture_state(v.id);
  return v;
end $$;

-- Customer view (section 5.2 rule 4): same visibility as get_my_drawers(); the chip is
-- derived server-side and a photo always wins. No error text, no timings.
create or replace function public.get_my_capture_status()
returns table (drawer_id uuid, display_state text, capture_updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  with me as (
    select c.id, c.organization_id
      from public.customer c
     where c.auth_user_id = (select auth.uid())
  ),
  mine as (
    select d.id, d.photo_url, d.capture_state, cap.updated_at
      from public.drawer d
      join public."order" o on o.id = d.order_id
      join me on (
            o.customer_id = me.id
         or (me.organization_id is not null and o.organization_id = me.organization_id)
         or (me.organization_id is not null and o.customer_id in (
               select c2.id from public.customer c2
                where c2.organization_id = me.organization_id))
      )
      left join public.capture cap on cap.id = d.current_capture_id
     where d.capture_state is not null
  )
  select m.id,
         case when m.photo_url is not null then null
              when m.capture_state in ('queued','processing') then 'processing'
              when m.capture_state = 'rescan_needed' then 'rescan_needed'
         end,
         m.updated_at
    from mine m
   where m.photo_url is null
     and m.capture_state in ('queued','processing','rescan_needed');
$$;

-- Staff/admin queue view. online = last_seen_at within 3 minutes.
create or replace function public.get_capture_queue(p_include_done boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_workers jsonb; v_captures jsonb;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'worker_id', w.worker_id, 'version', w.version, 'last_seen_at', w.last_seen_at,
           'online', w.last_seen_at > now() - interval '3 minutes',
           'current_capture_id', w.current_capture_id) order by w.worker_id), '[]'::jsonb)
    into v_workers
    from public.capture_worker w;
  select coalesce(jsonb_agg(t.j order by t.created_at desc), '[]'::jsonb) into v_captures
    from (select c.created_at, jsonb_build_object(
                 'capture_id', c.id, 'drawer_id', c.drawer_id, 'nickname', d.nickname,
                 'order_id', d.order_id, 'project_name', o.project_name,
                 'customer_name', coalesce(o.customer_name, cu.name),
                 'status', c.status, 'source', c.source,
                 'attempt_count', c.attempt_count, 'attempt_limit', c.attempt_limit,
                 'error', c.error, 'worker_id', c.worker_id, 'claimed_at', c.claimed_at,
                 'heartbeat_at', c.heartbeat_at, 'created_at', c.created_at,
                 'finished_at', c.finished_at, 'is_current', d.current_capture_id = c.id,
                 'frame_count', c.frame_count, 'timings', c.timings) as j
            from public.capture c
            join public.drawer d on d.id = c.drawer_id
            left join public."order" o on o.id = d.order_id
            left join public.customer cu on cu.id = o.customer_id
           where p_include_done or c.status <> 'done'
           order by c.created_at desc
           limit 500) t;
  return jsonb_build_object('workers', v_workers, 'captures', v_captures);
end $$;

-- Grants (house posture) -----------------------------------------------------------
revoke all on function public._can_capture_drawer(uuid)                             from public, anon, authenticated;
revoke all on function public._sync_drawer_capture_state(uuid)                      from public, anon, authenticated;
revoke all on function public._reap_stale_captures(text)                            from public, anon, authenticated;
revoke all on function public.create_capture(uuid,uuid,int,text,text,text,jsonb)    from public, anon;
revoke all on function public.claim_next_capture(text)                              from public, anon;
revoke all on function public.worker_heartbeat(text,uuid,int,text)                  from public, anon;
revoke all on function public.complete_capture(uuid,text,int,text,text,jsonb)       from public, anon;
revoke all on function public.fail_capture(uuid,text,int,text,text,jsonb)           from public, anon;
revoke all on function public.requeue_capture(uuid,text)                            from public, anon;
revoke all on function public.cancel_capture(uuid,text)                             from public, anon;
revoke all on function public.get_my_capture_status()                               from public, anon;
revoke all on function public.get_capture_queue(boolean)                            from public, anon;
grant execute on function public.create_capture(uuid,uuid,int,text,text,text,jsonb) to authenticated;
grant execute on function public.claim_next_capture(text)                           to authenticated;
grant execute on function public.worker_heartbeat(text,uuid,int,text)               to authenticated;
grant execute on function public.complete_capture(uuid,text,int,text,text,jsonb)    to authenticated;
grant execute on function public.fail_capture(uuid,text,int,text,text,jsonb)        to authenticated;
grant execute on function public.requeue_capture(uuid,text)                         to authenticated;
grant execute on function public.cancel_capture(uuid,text)                          to authenticated;
grant execute on function public.get_my_capture_status()                            to authenticated;
grant execute on function public.get_capture_queue(boolean)                         to authenticated;
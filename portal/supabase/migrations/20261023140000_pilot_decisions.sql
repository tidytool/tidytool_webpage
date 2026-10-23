-- ============================================================================
-- Follow-up to 20261023120000_remote_capture_queue + 20261023130000 (Todoist
-- 6hq6FjxP4V9rj3GM, round 3): Sam's pilot decisions of 2026-10-23.
--
-- Q1 (a) -- the Mac mini worker runs on the service-role key for the pilot.
--   * is_worker() is also true for a service_role caller (auth.role(), the same
--     claims reader auth.uid() uses). For every `authenticated` caller the role
--     claim is 'authenticated', so is_worker() keeps its meaning there and the
--     *_deny_worker policies (to authenticated) are unchanged; under service_role
--     they are inert anyway (BYPASSRLS) and stay correct for the post-pilot
--     worker user.
--   * Under service_role auth.uid() is null. The only worker-path writer of it is
--     capture_worker.auth_user_id in claim_next_capture / worker_heartbeat, which
--     was NOT NULL (23502 for a service_role caller). EXPAND-ONLY relaxation:
--     `alter column auth_user_id drop not null` -- null now means "service-role
--     caller, no auth user". No reader depends on it (get_capture_queue does not
--     expose it); claim_next_capture / worker_heartbeat bodies are unchanged.
--     attempts entries carry worker_id (the p_worker_id text), never auth.uid();
--     attempts `by` and capture.created_by are written only by the staff/customer
--     RPCs (requeue/cancel, create_capture), never on a worker path.
--   * Explicit EXECUTE for service_role on the four worker RPCs (additive; the
--     schema default privileges already grant it, this pins it).
--
-- Q4 declined -- complete_capture no longer advances a 'backlog' drawer to
-- 'scanned' (the section 5.3(b) legacy status write is removed). The worker sets
-- capture_state = 'ready' and fills photo_url/point_cloud_url if empty; it never
-- writes drawer.stage or drawer.status. 'scanned' means customer-confirmed.
--
-- Expand-only: one NOT NULL relaxed (above) plus body-only create or replace with
-- the same signatures, return types and existing grants. Nothing dropped or renamed.
--
-- ROLLBACK: re-run is_worker and complete_capture from 20261023120000; restore
-- `set not null` on capture_worker.auth_user_id only after deleting rows with a
-- null auth_user_id (the service_role grants can stay: they equal the default
-- privileges).
-- VERIFY: python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
-- ============================================================================

create or replace function public.is_worker()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
      or exists (select 1 from public.user_roles
                  where user_id = auth.uid() and role = 'worker');
$$;

alter table public.capture_worker alter column auth_user_id drop not null;

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

  -- Drawer: current capture only, fill-if-empty only (section 5.2). Never stage or
  -- legacy status (Q4 declined): 'scanned' is the customer's confirm, not the worker's.
  perform set_config('tidytool.capture_write', 'on', true);
  update public.drawer d
     set photo_url       = coalesce(d.photo_url, v.ortho_url),
         point_cloud_url = coalesce(d.point_cloud_url, v.model_url),
         capture_state   = 'ready'
   where d.id = v.drawer_id and d.current_capture_id = v.id;
  perform set_config('tidytool.capture_write', 'off', true);

  update public.capture_worker w
     set current_capture_id = null, last_seen_at = now()
   where w.worker_id = p_worker_id;
  return v;
end $$;

grant execute on function public.claim_next_capture(text)                        to service_role;
grant execute on function public.worker_heartbeat(text,uuid,int,text)            to service_role;
grant execute on function public.complete_capture(uuid,text,int,text,text,jsonb) to service_role;
grant execute on function public.fail_capture(uuid,text,int,text,text,jsonb)     to service_role;
-- ============================================================================
-- Follow-up to 20261023120000_remote_capture_queue (Todoist 6hq6FjxP4V9rj3GM,
-- reviewer round 1): worker_heartbeat lock order.
--
-- worker_heartbeat upserted capture_worker BEFORE updating capture, while
-- complete_capture / fail_capture lock capture first and capture_worker after.
-- A worker's heartbeat thread running beside its main thread (same worker_id)
-- could therefore deadlock (40P01). It also wrote p_capture_id into
-- capture_worker.current_capture_id unconditionally, so a beat for a capture
-- that no longer exists raised 23503 (FK) instead of returning false.
--
-- Fix (body-only create or replace, same signature, return type and grants):
-- update capture first, then upsert capture_worker with current_capture_id set
-- only when the claim is live. Lock order is now capture -> capture_worker ->
-- drawer in every capture RPC (contract section 8).
--
-- ROLLBACK: re-run the worker_heartbeat body from 20261023120000.
-- VERIFY: python3 tools/db_test.py portal/supabase/tests/remote_capture_rls_test.sql
-- ============================================================================

create or replace function public.worker_heartbeat(
  p_worker_id  text,
  p_capture_id uuid default null,
  p_attempt    int  default null,
  p_version    text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_live boolean := false;
begin
  if not public.is_worker() then
    raise exception 'worker role required' using errcode = '42501';
  end if;

  -- capture first (lock order, section 8): bump the live claim only.
  if p_capture_id is not null then
    update public.capture
       set heartbeat_at = now(), updated_at = now()
     where id = p_capture_id and status = 'processing'
       and worker_id = p_worker_id and attempt_count = p_attempt;
    v_live := found;
  end if;

  -- then capture_worker: liveness, pointing at the capture only while the claim is live.
  insert into public.capture_worker (worker_id, auth_user_id, version, current_capture_id, last_seen_at)
  values (p_worker_id, auth.uid(), p_version, case when v_live then p_capture_id end, now())
  on conflict (worker_id) do update
     set auth_user_id       = excluded.auth_user_id,
         version            = coalesce(excluded.version, public.capture_worker.version),
         current_capture_id = excluded.current_capture_id,
         last_seen_at       = now();

  if p_capture_id is null then
    return true;
  end if;
  return v_live;
end $$;

revoke all on function public.worker_heartbeat(text,uuid,int,text) from public, anon;
grant execute on function public.worker_heartbeat(text,uuid,int,text) to authenticated;
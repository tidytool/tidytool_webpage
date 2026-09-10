-- Admin cleanup controls (2026-09-10)
--
-- Fixes the three defects that made order cleanup impossible from the admin
-- UI (found during the 2026-09-10 manual cleanup session):
--
--   1. admin_delete_order / admin_delete_drawer were broken for any record
--      with history: the append-only guard triggers on drawer_event and
--      status_event (added later, in 20260628164449 / 20260727100000-era
--      hardening) block their deletes, including the FK cascade from
--      drawer/order into status_event. Fix: the guard functions now allow
--      DELETE — never UPDATE, never TRUNCATE — when the transaction-local
--      setting tidytool.allow_audited_purge = 'on'. Only the two admin
--      delete functions set it (and reset it immediately after their
--      deletes), so append-only remains true for every other path: no RPC
--      exposes set_config, so PostgREST clients cannot reach the setting.
--      Both delete functions also now snapshot status_event history into
--      the admin_audit before-image alongside drawers and drawer_events.
--
--   2. mark_drawer_delivered predates the status backbone: it logged a
--      'delivered' drawer_event but never advanced drawer.stage, so the
--      tracker, pipeline, and computed order status did not move. It now
--      advances stage to 'delivered' with a 'correction' status_event
--      (mirroring set_drawer_stage's correction path), refuses cancelled
--      drawers, and stays idempotent when the drawer is already delivered.
--      admin_bulk_mark_delivered / admin_bulk_delete_* loop the singles and
--      inherit the fixes unchanged.
--
--   3. Sam had no admin role: user_roles held only staff rows for
--      sam@thetidytool.com and samochristensen@gmail.com, so the owner of
--      the business could not use any "Admins only" control. Grants the
--      admin role to sam@thetidytool.com (idempotent).
--
-- Signatures are unchanged throughout, so existing grants carry over and
-- PostgREST needs only a schema reload (notify pgrst below).
--
-- APPLIED to prod 2026-09-10 via MCP (version 20260910175336) after a
-- rollback-only validation pass against the live schema: delete-with-history
-- + audit snapshot, guard re-arm after the purge window, UPDATE still blocked
-- under the setting, stage advance + idempotency, cancelled-drawer refusal,
-- staff-only and anonymous refusal.

-- ---------------------------------------------------------------------------
-- 1. Append-only guards: allow DELETE under the audited-purge setting only.
-- ---------------------------------------------------------------------------

create or replace function public.drawer_event_immutable()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('tidytool.allow_audited_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'drawer_event is append-only; % is not permitted', tg_op
    using errcode = '0A000';
end;
$$;

create or replace function public.status_event_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('tidytool.allow_audited_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'status_event is append-only (% blocked)', tg_op
    using errcode = '0A000';
end;
$$;

comment on function public.drawer_event_immutable() is
  'Append-only guard. DELETE (only) is permitted while the transaction-local '
  'setting tidytool.allow_audited_purge = ''on'' — set exclusively by '
  'admin_delete_order/admin_delete_drawer after writing an admin_audit snapshot.';
comment on function public.status_event_immutable() is
  'Append-only guard. DELETE (only) is permitted while the transaction-local '
  'setting tidytool.allow_audited_purge = ''on'' — set exclusively by '
  'admin_delete_order/admin_delete_drawer after writing an admin_audit snapshot. '
  'TRUNCATE and UPDATE are always blocked.';

-- ---------------------------------------------------------------------------
-- 2a. admin_delete_order — snapshot (incl. status events), audited purge.
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_order   public."order"%rowtype;
  v_drawers jsonb;
  v_events  jsonb;
  v_sevents jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_order from public."order" where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) into v_drawers
    from public.drawer d where d.order_id = p_order_id;
  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) into v_events
    from public.drawer_event e
   where e.drawer_id in (select d.id from public.drawer d where d.order_id = p_order_id);
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_sevents
    from public.status_event s
   where s.order_id = p_order_id
      or s.drawer_id in (select d.id from public.drawer d where d.order_id = p_order_id);

  perform public._admin_audit('delete_order', 'order', p_order_id,
    jsonb_build_object('order', to_jsonb(v_order),
                       'drawers', v_drawers,
                       'drawer_events', v_events,
                       'status_events', v_sevents),
    null);

  -- Audited purge window: history deletes (direct and via FK cascade) are
  -- allowed only between these two set_config calls, in this transaction.
  perform set_config('tidytool.allow_audited_purge', 'on', true);
  delete from public.drawer_event
   where drawer_id in (select d.id from public.drawer d where d.order_id = p_order_id);
  delete from public.drawer where order_id = p_order_id;
  delete from public."order" where id = p_order_id;
  perform set_config('tidytool.allow_audited_purge', 'off', true);

  return json_build_object('ok', true, 'order_id', p_order_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. admin_delete_drawer — same pattern for a single drawer.
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_drawer(p_drawer_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_drawer  public.drawer%rowtype;
  v_events  jsonb;
  v_sevents jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_drawer from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) into v_events
    from public.drawer_event e where e.drawer_id = p_drawer_id;
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into v_sevents
    from public.status_event s where s.drawer_id = p_drawer_id;

  perform public._admin_audit('delete_drawer', 'drawer', p_drawer_id,
    jsonb_build_object('drawer', to_jsonb(v_drawer),
                       'drawer_events', v_events,
                       'status_events', v_sevents),
    null);

  perform set_config('tidytool.allow_audited_purge', 'on', true);
  delete from public.drawer_event where drawer_id = p_drawer_id;
  delete from public.drawer where id = p_drawer_id;
  perform set_config('tidytool.allow_audited_purge', 'off', true);

  return json_build_object('ok', true, 'drawer_id', p_drawer_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. mark_drawer_delivered — actually advance the stage (post-backbone).
-- ---------------------------------------------------------------------------

create or replace function public.mark_drawer_delivered(p_drawer_id uuid, p_note text default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d        public.drawer%rowtype;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_legacy public.drawer_status;
  v_moved  boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  if d.state = 'cancelled' then
    raise exception 'This drawer is cancelled — reactivate it before marking it delivered.'
      using errcode = '22000';
  end if;

  if coalesce(d.stage, '') <> 'delivered' then
    v_legacy := public.map_stage_to_legacy('delivered');
    update public.drawer
       set stage = 'delivered',
           status = coalesce(v_legacy, status)
     where id = p_drawer_id;
    perform public.record_status_event('drawer', 'stage', 'correction',
      d.order_id, p_drawer_id, d.stage, 'delivered', 'portal',
      coalesce(v_note, 'Marked delivered from admin'), null, null);
    v_moved := true;
  end if;

  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note)
  values
    (p_drawer_id, coalesce(d.current_revision, 0), 'delivered', 'TidyTool', 'staff', v_note);

  perform public._admin_audit('mark_drawer_delivered', 'drawer', p_drawer_id,
    jsonb_build_object('stage', d.stage),
    jsonb_build_object('stage', 'delivered', 'stage_changed', v_moved, 'note', v_note));

  return json_build_object('ok', true, 'drawer_id', p_drawer_id, 'stage_changed', v_moved);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Sam gets the admin role (idempotent). Owner of the business could not
--    previously use any "Admins only" control.
-- ---------------------------------------------------------------------------

insert into public.user_roles (user_id, role)
select u.id, 'admin'
  from auth.users u
 where u.email = 'sam@thetidytool.com'
   and not exists (
     select 1 from public.user_roles ur
      where ur.user_id = u.id and ur.role = 'admin');

-- Ask PostgREST to reload so RPC changes are visible immediately.
notify pgrst, 'reload schema';

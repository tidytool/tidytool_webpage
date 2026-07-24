-- ============================================================================
-- T3.5c — Bulk operations everywhere + relaxed customer delete
-- (Sam, 2026-07-05: multi-select on every admin list; customer delete should
--  unlink orders instead of being blocked; drawers deletable for test data.)
--
-- WHAT
--   1. admin_delete_customer v2 — customers WITH orders are now deletable:
--      their orders are unlinked (customer_id/organization_id -> null, so they
--      reappear as "unassigned") and the customer row is removed. The
--      portal-login guard stays: a customer with auth_user_id is never
--      deletable from the UI. Audit logs the before-image + unlinked count.
--   2. admin_bulk_delete_customers(uuid[]).
--   3. admin_delete_drawer(uuid) — hard delete one drawer + its events, full
--      before-image audit-logged. For test rows; a real drawer disappears
--      from the ops pipeline, hence the typed confirmation in the UI.
--   4. admin_bulk_delete_drawers(uuid[]).
--   5. admin_bulk_mark_delivered(uuid[], note) — one shared optional note.
--   6. admin_bulk_delete_organizations(uuid[]) — same emptiness guard as
--      admin_delete_organization, applied per org.
--
-- All SECURITY DEFINER, re-check is_admin(), revoked from anon/public.
-- ROLLBACK: drop 2–6; restore admin_delete_customer from 20260707000000.
-- ============================================================================

-- 1) customer delete v2: unlink orders, then delete --------------------------
create or replace function public.admin_delete_customer(p_customer_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_cust     public.customer%rowtype;
  v_unlinked int;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_cust from public.customer where id = p_customer_id for update;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if v_cust.auth_user_id is not null then
    raise exception 'This customer has a login account — cannot delete.'
      using errcode = '22000';
  end if;

  -- Unlink (not delete) their orders: they become "unassigned" again.
  -- Clear organization_id too — it was inherited from this customer.
  update public."order"
     set customer_id = null,
         organization_id = null
   where customer_id = p_customer_id;
  get diagnostics v_unlinked = row_count;

  perform public._admin_audit('delete_customer', 'customer', p_customer_id,
    to_jsonb(v_cust),
    jsonb_build_object('orders_unlinked', v_unlinked));
  delete from public.customer where id = p_customer_id;
  return json_build_object('ok', true, 'orders_unlinked', v_unlinked);
end;
$$;

-- 2) bulk customer delete ------------------------------------------------------
create or replace function public.admin_bulk_delete_customers(p_customer_ids uuid[])
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    raise exception 'No customers selected.' using errcode = '22000';
  end if;
  foreach v_id in array p_customer_ids loop
    perform public.admin_delete_customer(v_id);  -- audits each individually
    v_n := v_n + 1;
  end loop;
  return json_build_object('ok', true, 'deleted', v_n);
end;
$$;

-- 3) drawer delete ----------------------------------------------------------------
create or replace function public.admin_delete_drawer(p_drawer_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_drawer public.drawer%rowtype;
  v_events jsonb;
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

  perform public._admin_audit('delete_drawer', 'drawer', p_drawer_id,
    jsonb_build_object('drawer', to_jsonb(v_drawer), 'drawer_events', v_events),
    null);

  delete from public.drawer_event where drawer_id = p_drawer_id;
  delete from public.drawer where id = p_drawer_id;
  return json_build_object('ok', true, 'drawer_id', p_drawer_id);
end;
$$;

-- 4) bulk drawer delete --------------------------------------------------------------
create or replace function public.admin_bulk_delete_drawers(p_drawer_ids uuid[])
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_drawer_ids is null or array_length(p_drawer_ids, 1) is null then
    raise exception 'No drawers selected.' using errcode = '22000';
  end if;
  foreach v_id in array p_drawer_ids loop
    perform public.admin_delete_drawer(v_id);
    v_n := v_n + 1;
  end loop;
  return json_build_object('ok', true, 'deleted', v_n);
end;
$$;

-- 5) bulk mark delivered ---------------------------------------------------------------
create or replace function public.admin_bulk_mark_delivered(
  p_drawer_ids uuid[], p_note text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_drawer_ids is null or array_length(p_drawer_ids, 1) is null then
    raise exception 'No drawers selected.' using errcode = '22000';
  end if;
  foreach v_id in array p_drawer_ids loop
    perform public.mark_drawer_delivered(v_id, p_note);
    v_n := v_n + 1;
  end loop;
  return json_build_object('ok', true, 'delivered', v_n);
end;
$$;

-- 6) bulk org delete ----------------------------------------------------------------------
create or replace function public.admin_bulk_delete_organizations(p_organization_ids uuid[])
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_organization_ids is null or array_length(p_organization_ids, 1) is null then
    raise exception 'No organizations selected.' using errcode = '22000';
  end if;
  foreach v_id in array p_organization_ids loop
    perform public.admin_delete_organization(v_id);  -- emptiness guard per org
    v_n := v_n + 1;
  end loop;
  return json_build_object('ok', true, 'deleted', v_n);
end;
$$;

-- Lock down ---------------------------------------------------------------------------------
revoke execute on function public.admin_bulk_delete_customers(uuid[])     from public, anon;
revoke execute on function public.admin_delete_drawer(uuid)               from public, anon;
revoke execute on function public.admin_bulk_delete_drawers(uuid[])       from public, anon;
revoke execute on function public.admin_bulk_mark_delivered(uuid[], text) from public, anon;
revoke execute on function public.admin_bulk_delete_organizations(uuid[]) from public, anon;
grant execute on function public.admin_bulk_delete_customers(uuid[])      to authenticated;
grant execute on function public.admin_delete_drawer(uuid)                to authenticated;
grant execute on function public.admin_bulk_delete_drawers(uuid[])        to authenticated;
grant execute on function public.admin_bulk_mark_delivered(uuid[], text)  to authenticated;
grant execute on function public.admin_bulk_delete_organizations(uuid[])  to authenticated;

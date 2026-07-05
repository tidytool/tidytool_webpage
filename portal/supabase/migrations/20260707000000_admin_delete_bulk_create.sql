-- ============================================================================
-- T3.5b — Admin delete, bulk operations, and manual order creation
-- (Requested by Sam 2026-07-05: clean up test data, bulk-manage unassigned
--  orders, and create orders/customers/orgs manually from /admin.)
--
-- WHAT
--   1. admin_delete_order(uuid)            — hard delete an order + its drawers
--      + drawer events. Full before-image (order, drawers, events) is written
--      to the append-only admin_audit log BEFORE deletion, so nothing is
--      silently lost.
--   2. admin_bulk_delete_orders(uuid[])    — same, for a selection.
--   3. admin_bulk_assign_orders(uuid[], uuid) — assign a selection of orders
--      to one customer (mirrors assign_order_to_customer semantics).
--   4. admin_delete_customer(uuid)         — only if the customer has no
--      orders and no login (auth_user_id). Duplicates with orders use merge.
--   5. admin_delete_organization(uuid)     — only if no customers or orders
--      reference it.
--   6. admin_create_order(...)             — manual order entry. The T3
--      link_order_to_customer trigger auto-links a clean email; an explicit
--      p_customer_id wins (trigger respects explicit links).
--
-- All RPCs are SECURITY DEFINER, re-check is_admin() internally, and are
-- revoked from anon/public (defense in depth — same pattern as T3/T3.5).
--
-- ROLLBACK: drop the six functions.
-- ============================================================================

-- 1) delete one order (audit first, then drawer_event -> drawer -> order) ----
create or replace function public.admin_delete_order(p_order_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_order   public."order"%rowtype;
  v_drawers jsonb;
  v_events  jsonb;
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

  -- Audit BEFORE deleting so a failure can never lose the before-image.
  perform public._admin_audit('delete_order', 'order', p_order_id,
    jsonb_build_object('order', to_jsonb(v_order),
                       'drawers', v_drawers,
                       'drawer_events', v_events),
    null);

  delete from public.drawer_event
   where drawer_id in (select d.id from public.drawer d where d.order_id = p_order_id);
  delete from public.drawer where order_id = p_order_id;
  delete from public."order" where id = p_order_id;

  return json_build_object('ok', true, 'order_id', p_order_id);
end;
$$;

-- 2) bulk delete ---------------------------------------------------------------
create or replace function public.admin_bulk_delete_orders(p_order_ids uuid[])
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
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'No orders selected.' using errcode = '22000';
  end if;
  foreach v_id in array p_order_ids loop
    perform public.admin_delete_order(v_id);  -- audits each order individually
    v_n := v_n + 1;
  end loop;
  return json_build_object('ok', true, 'deleted', v_n);
end;
$$;

-- 3) bulk assign -----------------------------------------------------------------
create or replace function public.admin_bulk_assign_orders(
  p_order_ids uuid[], p_customer_id uuid
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_cust public.customer%rowtype;
  v_n    int;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_order_ids is null or array_length(p_order_ids, 1) is null then
    raise exception 'No orders selected.' using errcode = '22000';
  end if;
  select * into v_cust from public.customer where id = p_customer_id;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  update public."order"
     set customer_id     = v_cust.id,
         organization_id = coalesce(organization_id, v_cust.organization_id)
   where id = any(p_order_ids);
  get diagnostics v_n = row_count;

  perform public._admin_audit('bulk_assign_orders', 'order', null,
    null,
    jsonb_build_object('customer_id', p_customer_id,
                       'order_ids', to_jsonb(p_order_ids),
                       'assigned', v_n));
  return json_build_object('ok', true, 'assigned', v_n);
end;
$$;

-- 4) delete customer (no orders, no login) ---------------------------------------
create or replace function public.admin_delete_customer(p_customer_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_cust public.customer%rowtype;
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
  if exists (select 1 from public."order" o where o.customer_id = p_customer_id) then
    raise exception 'This customer has orders — merge into another customer instead.'
      using errcode = '22000';
  end if;

  perform public._admin_audit('delete_customer', 'customer', p_customer_id,
                              to_jsonb(v_cust), null);
  delete from public.customer where id = p_customer_id;
  return json_build_object('ok', true);
end;
$$;

-- 5) delete organization (must be empty) ------------------------------------------
create or replace function public.admin_delete_organization(p_organization_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_org public.organization%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_org from public.organization where id = p_organization_id for update;
  if not found then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.customer c where c.organization_id = p_organization_id)
     or exists (select 1 from public."order" o where o.organization_id = p_organization_id) then
    raise exception 'Organization still has customers or orders — reassign them first.'
      using errcode = '22000';
  end if;

  perform public._admin_audit('delete_organization', 'organization',
                              p_organization_id, to_jsonb(v_org), null);
  delete from public.organization where id = p_organization_id;
  return json_build_object('ok', true);
end;
$$;

-- 6) manual order creation ----------------------------------------------------------
create or replace function public.admin_create_order(
  p_customer_name text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_project_name text default null,
  p_location text default null,
  p_notes text default null,
  p_drawer_count bigint default null,
  p_total_price_cents bigint default null,
  p_customer_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_customer_email, ''))), '');
  v_order public."order"%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_customer_name, '')) = '' then
    raise exception 'A customer name is required.' using errcode = '22000';
  end if;
  if v_email is not null
     and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;
  if p_drawer_count is not null and p_drawer_count < 0 then
    raise exception 'drawer_count must be >= 0.' using errcode = '22000';
  end if;
  if p_total_price_cents is not null and p_total_price_cents < 0 then
    raise exception 'total_price must be >= 0 (integer cents).' using errcode = '22000';
  end if;
  if p_customer_id is not null
     and not exists (select 1 from public.customer where id = p_customer_id) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  -- link_order_to_customer trigger fills customer_id/organization_id from a
  -- clean email; an explicit p_customer_id is respected by the trigger.
  insert into public."order"
    (customer_name, customer_email, customer_phone, project_name,
     location, notes, drawer_count, total_price, customer_id)
  values
    (btrim(p_customer_name), v_email,
     nullif(btrim(coalesce(p_customer_phone, '')), ''),
     nullif(btrim(coalesce(p_project_name, '')), ''),
     nullif(btrim(coalesce(p_location, '')), ''),
     nullif(btrim(coalesce(p_notes, '')), ''),
     p_drawer_count, p_total_price_cents, p_customer_id)
  returning * into v_order;

  perform public._admin_audit('create_order', 'order', v_order.id,
                              null, to_jsonb(v_order));
  return v_order.id;
end;
$$;

-- Lock down: guarded internally, but don't even expose to anon. ---------------------
revoke execute on function public.admin_delete_order(uuid)                     from public, anon;
revoke execute on function public.admin_bulk_delete_orders(uuid[])             from public, anon;
revoke execute on function public.admin_bulk_assign_orders(uuid[], uuid)       from public, anon;
revoke execute on function public.admin_delete_customer(uuid)                  from public, anon;
revoke execute on function public.admin_delete_organization(uuid)              from public, anon;
revoke execute on function public.admin_create_order(text, text, text, text, text, text, bigint, bigint, uuid) from public, anon;
grant execute on function public.admin_delete_order(uuid)                      to authenticated;
grant execute on function public.admin_bulk_delete_orders(uuid[])              to authenticated;
grant execute on function public.admin_bulk_assign_orders(uuid[], uuid)        to authenticated;
grant execute on function public.admin_delete_customer(uuid)                   to authenticated;
grant execute on function public.admin_delete_organization(uuid)               to authenticated;
grant execute on function public.admin_create_order(text, text, text, text, text, text, bigint, bigint, uuid) to authenticated;

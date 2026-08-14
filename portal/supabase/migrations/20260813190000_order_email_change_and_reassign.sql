-- Staff-driven customer email changes that actually move the link.
--
-- WHAT: adds set_order_customer_email(p_order_id, p_new_email, p_mode), a
-- staff RPC tidyCAM calls when an operator edits the customer email on an
-- order, plus _try_link_customer_auth(), an internal backstop that links a
-- customer row to an existing auth user with the same email. Also re-creates
-- admin_update_customer with that backstop after email edits.
--
-- WHY: order.customer_email is a historical claim key, not the link — the
-- real link is order.customer_id, and link_order_to_customer deliberately
-- refuses to re-point an order that already has one. So editing the email in
-- tidyCAM (or admin_update_order) silently changes nothing about visibility.
-- Field incident 2026-08-12/13: an order edited from test@ to shem@ stayed
-- attached to the test@ customer row, and the portal (get_my_drawers scopes
-- by customer.auth_user_id) showed nothing. Separately, link_customer_on_auth
-- only fires on auth.users INSERT, so a customer row created (or re-emailed)
-- after its person signed up never links — the backstop closes that.
--
-- The raw-write trigger stays conservative on purpose; intent must be
-- explicit because one email edit means two different things:
--   mode 'customer_changed' — same person, new address. Updates the linked
--     customer row's email (all their orders follow via customer_id), stamps
--     this order's customer_email, refreshes the auth link. Errors if another
--     customer already owns the email (merge or reassign instead).
--   mode 'reassign' — this order belongs to someone else. Finds-or-creates
--     the customer for the new email (mirroring link_order_to_customer),
--     re-points customer_id/organization_id, stamps customer_email.
--   Unlinked (orphaned) orders: both modes reduce to claim-by-email.
--
-- ROLLBACK: drop function public.set_order_customer_email(uuid, text, text);
--   drop function public._try_link_customer_auth(uuid); restore the 0006
--   (20260707000000_admin_crm) body of admin_update_customer, which is
--   identical minus the _try_link_customer_auth call.
--
-- VERIFICATION (branch-tested before prod):
--   1. customer_changed: linked order, fresh email -> customer.email updated,
--      order.customer_email updated, customer_id unchanged, sibling orders
--      still visible to the same login.
--   2. customer_changed onto an email owned by another customer -> 23505.
--   3. reassign to an existing customer -> customer_id re-points, org follows.
--   4. reassign to a brand-new email -> customer created, auth-linked when a
--      matching auth user exists.
--   5. non-staff caller -> 42501. anon/public -> no execute grant.

-- 1) auth-link backstop ---------------------------------------------------------
-- link_customer_on_auth covers "auth user created after customer row"; this
-- covers the mirror image. The not-exists guard respects the partial unique
-- index on auth_user_id (an auth user can only claim one customer row).
create or replace function public._try_link_customer_auth(p_customer_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.customer c
     set auth_user_id = u.id
    from auth.users u
   where c.id = p_customer_id
     and c.auth_user_id is null
     and c.email is not null
     and u.email is not null
     and lower(u.email) = c.email
     and not exists (select 1 from public.customer c2 where c2.auth_user_id = u.id);
$$;
revoke all on function public._try_link_customer_auth(uuid) from public, anon, authenticated;

-- 2) the staff RPC --------------------------------------------------------------
create or replace function public.set_order_customer_email(
  p_order_id  uuid,
  p_new_email text,
  p_mode      text default 'customer_changed'
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text := lower(btrim(coalesce(p_new_email, '')));
  v_order  public."order"%rowtype;
  v_cust   public.customer%rowtype;  -- currently linked customer
  v_target public.customer%rowtype;  -- customer already owning the new email
  v_before jsonb;
begin
  if not public.is_staff() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_mode not in ('customer_changed', 'reassign') then
    raise exception 'mode must be customer_changed or reassign' using errcode = '22000';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;

  select * into v_order from public."order" where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  select * into v_target from public.customer where lower(email) = v_email limit 1;

  if v_order.customer_id is not null and p_mode = 'customer_changed' then
    -- Same person, new address: email follows the customer row; every order
    -- linked by customer_id follows automatically.
    select * into v_cust from public.customer where id = v_order.customer_id for update;
    if v_target.id is not null and v_target.id <> v_cust.id then
      raise exception 'Another customer already uses %. Reassign the order or merge the customers.', v_email
        using errcode = '23505';
    end if;
    v_before := to_jsonb(v_cust);
    update public.customer set email = v_email where id = v_cust.id
      returning * into v_cust;
    perform public._try_link_customer_auth(v_cust.id);
    update public."order" set customer_email = v_email where id = p_order_id;
    perform public._admin_audit('order_email_customer_changed', 'customer', v_cust.id,
                                v_before, to_jsonb(v_cust));
  else
    -- Reassign (or claim an orphaned order): find-or-create the customer for
    -- the new email, mirroring link_order_to_customer's race handling.
    if v_target.id is null then
      insert into public.customer (name, phone, email)
      values (v_order.customer_name, v_order.customer_phone, v_email)
      on conflict ((lower(email))) where email is not null do nothing
      returning * into v_target;
      if v_target.id is null then  -- lost a concurrent race; row exists now
        select * into v_target from public.customer where lower(email) = v_email limit 1;
      end if;
    end if;
    perform public._try_link_customer_auth(v_target.id);
    select * into v_target from public.customer where id = v_target.id;

    v_before := to_jsonb(v_order);
    update public."order"
       set customer_id     = v_target.id,
           organization_id = v_target.organization_id,
           customer_email  = v_email
     where id = p_order_id
     returning * into v_order;
    perform public._admin_audit('order_email_reassigned', 'order', p_order_id,
                                v_before, to_jsonb(v_order));
  end if;

  return json_build_object(
    'ok', true,
    'mode', case when v_order.customer_id is not null and v_cust.id is not null
                 then 'customer_changed' else 'reassign' end,
    'customer_id', coalesce(v_cust.id, v_target.id),
    'email', v_email,
    'auth_linked', coalesce(v_cust.auth_user_id, v_target.auth_user_id) is not null);
end;
$$;
revoke all on function public.set_order_customer_email(uuid, text, text) from public, anon;
grant execute on function public.set_order_customer_email(uuid, text, text) to authenticated;

-- 3) admin_update_customer gains the auth-link backstop --------------------------
-- Body identical to 20260707000000_admin_crm plus the perform after the update,
-- so a portal-admin email edit also links an already-signed-up user.
create or replace function public.admin_update_customer(
  p_customer_id uuid,
  p_name  text default null,
  p_email text default null,
  p_phone text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_before public.customer%rowtype;
  v_after  public.customer%rowtype;
  v_email  text := case when p_email is null then null
                        else nullif(lower(btrim(p_email)), '') end;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_before from public.customer where id = p_customer_id for update;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if v_email is not null
     and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;

  update public.customer set
    name  = coalesce(p_name, name),
    email = case when p_email is null then email else v_email end,  -- '' clears to null
    phone = coalesce(p_phone, phone)
  where id = p_customer_id
  returning * into v_after;

  if v_email is not null then
    perform public._try_link_customer_auth(p_customer_id);
    select * into v_after from public.customer where id = p_customer_id;
  end if;

  perform public._admin_audit('update_customer', 'customer', p_customer_id,
                              to_jsonb(v_before), to_jsonb(v_after));
  return json_build_object('ok', true);
exception when unique_violation then
  raise exception 'Another customer already has this email.' using errcode = '23505';
end;
$$;

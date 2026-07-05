-- ============================================================================
-- T3 — Portal on the durable model + admin RPCs
-- (ARCHITECTURE.md pillars 1 & 5; decisions 5, 7; bridge-removal decided w/ Sam 2026-07-05)
--
-- WHAT
--   1. Auto-link trigger on "order": on insert (or customer_email update), a
--      clean email upserts the matching customer row and sets customer_id +
--      organization_id. Makes the 0004 backfill continuous, so the email
--      bridge in get_my_drawers can be dropped NOW instead of waiting for
--      tidyCAM to write links (cross-repo step retires the trigger later).
--      Dirty/empty emails stay orphaned (decision 5). Explicit customer_id
--      values are respected and never overwritten.
--   2. One-time catch-up pass for orders created between 0004 and this apply.
--   3. get_my_drawers v2: keyed on customer_id, whole-org visibility
--      (decision 6/28). Same signature and return shape — the portal
--      dashboard needs zero changes. Email bridge REMOVED.
--   4. 'delivered' added to drawer_event.event_type (decision 7: delivered is
--      an admin action writing an event; ops enum stays untouched).
--   5. Admin RPCs (user_roles-gated inside, SECURITY DEFINER):
--      get_admin_pipeline, get_admin_orphan_orders, get_admin_customers,
--      assign_order_to_customer, admin_create_customer, mark_drawer_delivered.
--
-- UNTOUCHED: drawer_status enum, order.drawer_ids, qr_url, approval RPCs,
--   tidyCAM write paths (trigger is additive; explicit values win).
--
-- ROLLBACK
--   drop trigger link_order_to_customer on public."order";
--   drop function link_order_to_customer();
--   drop the six admin RPCs; restore get_my_drawers from
--   20260628223234_add_get_my_drawers.sql; restore the event_type check
--   without 'delivered' (only safe if no 'delivered' events exist yet).
--
-- VERIFICATION (after apply)
--   insert a test order with a known-new clean email -> customer row created,
--     customer_id set (then delete both);
--   select count(*) from "order" where customer_id is null;  -- only dirty-email orders
--   as a non-admin: select get_admin_pipeline();             -- raises 42501
-- ============================================================================

-- 1) auto-link trigger ---------------------------------------------------------
create or replace function public.link_order_to_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(new.customer_email, '')));
  v_cust  public.customer%rowtype;
begin
  -- Respect explicit links (future tidyCAM intake linking); just fill org.
  if new.customer_id is not null then
    if new.organization_id is null then
      select organization_id into new.organization_id
        from public.customer where id = new.customer_id;
    end if;
    return new;
  end if;

  -- Dirty/empty email -> stays orphaned, admin maps it later (decision 5).
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return new;
  end if;

  select * into v_cust from public.customer where lower(email) = v_email limit 1;
  if not found then
    insert into public.customer (name, phone, email)
    values (new.customer_name, new.customer_phone, v_email)
    on conflict ((lower(email))) where email is not null do nothing
    returning * into v_cust;
    if v_cust.id is null then  -- lost a concurrent race; row exists now
      select * into v_cust from public.customer where lower(email) = v_email limit 1;
    end if;
  end if;

  new.customer_id := v_cust.id;
  if new.organization_id is null then
    new.organization_id := v_cust.organization_id;
  end if;
  return new;
end;
$$;
revoke execute on function public.link_order_to_customer() from public, anon, authenticated;

drop trigger if exists link_order_to_customer on public."order";
create trigger link_order_to_customer
  before insert or update of customer_email on public."order"
  for each row execute function public.link_order_to_customer();

-- 2) one-time catch-up for orders created since 0004 ---------------------------
insert into public.customer (name, phone, email)
select distinct on (lower(btrim(o.customer_email)))
       o.customer_name, o.customer_phone, lower(btrim(o.customer_email))
  from public."order" o
 where o.customer_id is null
   and btrim(coalesce(o.customer_email, ''))
       ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
   and not exists (select 1 from public.customer c
                    where c.email = lower(btrim(o.customer_email)))
 order by lower(btrim(o.customer_email)), o.created_at desc;

update public."order" o
   set customer_id     = c.id,
       organization_id = coalesce(o.organization_id, c.organization_id)
  from public.customer c
 where o.customer_id is null
   and btrim(coalesce(o.customer_email, '')) <> ''
   and lower(btrim(o.customer_email)) = c.email;

-- 3) get_my_drawers v2: customer_id + whole-org; email bridge removed -----------
create or replace function public.get_my_drawers()
returns table (
  id uuid,
  nickname text,
  status drawer_status,
  customer_approval_status text,
  design_preview_url text,
  photo_url text,
  dimensions json,
  order_id uuid,
  project_name text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with me as (
    select c.id, c.organization_id
      from public.customer c
     where c.auth_user_id = (select auth.uid())
  )
  select d.id, d.nickname, d.status, d.customer_approval_status,
         d.design_preview_url, d.photo_url, d.dimensions, d.order_id,
         o.project_name, d.created_at
    from public.drawer d
    join public."order" o on o.id = d.order_id
    join me on (
          o.customer_id = me.id
       or (me.organization_id is not null and o.organization_id = me.organization_id)
       or (me.organization_id is not null and o.customer_id in (
             select c2.id from public.customer c2
              where c2.organization_id = me.organization_id))
    )
   order by d.created_at desc;
$$;
revoke all on function public.get_my_drawers() from public, anon;
grant execute on function public.get_my_drawers() to authenticated;

-- 4) 'delivered' event type (decision 7) ----------------------------------------
alter table public.drawer_event drop constraint if exists drawer_event_event_type_check;
alter table public.drawer_event add constraint drawer_event_event_type_check
  check (event_type in
    ('design_uploaded','design_revised','approved','changes_requested','delivered'));

-- 5) admin RPCs ------------------------------------------------------------------
create or replace function public.get_admin_pipeline()
returns table (
  drawer_id uuid, nickname text, status drawer_status,
  customer_approval_status text, current_revision int,
  approved_by text, approved_at timestamptz,
  order_id uuid, project_name text,
  customer_id uuid, customer_name text, customer_email text,
  created_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select d.id, d.nickname, d.status, d.customer_approval_status,
           d.current_revision, d.approved_by, d.approved_at,
           o.id, o.project_name, o.customer_id,
           coalesce(c.name, o.customer_name), coalesce(c.email, o.customer_email),
           d.created_at
      from public.drawer d
      left join public."order" o on o.id = d.order_id
      left join public.customer c on c.id = o.customer_id
     order by d.created_at desc;
end;
$$;

create or replace function public.get_admin_orphan_orders()
returns table (
  order_id uuid, created_at timestamptz, customer_name text,
  customer_email text, customer_phone text, project_name text,
  drawer_count bigint, total_price bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select o.id, o.created_at, o.customer_name, o.customer_email,
           o.customer_phone, o.project_name, o.drawer_count, o.total_price
      from public."order" o
     where o.customer_id is null
     order by o.created_at desc;
end;
$$;

create or replace function public.get_admin_customers()
returns table (
  customer_id uuid, name text, email text,
  organization_id uuid, organization_name text
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select c.id, c.name, c.email, c.organization_id, g.name
      from public.customer c
      left join public.organization g on g.id = c.organization_id
     order by coalesce(c.name, c.email);
end;
$$;

create or replace function public.assign_order_to_customer(
  p_order_id uuid, p_customer_id uuid
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_cust public.customer%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into v_cust from public.customer where id = p_customer_id;
  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  update public."order"
     set customer_id     = v_cust.id,
         organization_id = coalesce(organization_id, v_cust.organization_id)
   where id = p_order_id;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  return json_build_object('ok', true, 'order_id', p_order_id, 'customer_id', v_cust.id);
end;
$$;

create or replace function public.admin_create_customer(
  p_name text, p_email text default null, p_phone text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'A name is required.' using errcode = '22000';
  end if;
  if v_email is not null
     and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email.' using errcode = '22000';
  end if;
  insert into public.customer (name, phone, email)
  values (btrim(p_name), nullif(btrim(coalesce(p_phone,'')), ''), v_email)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A customer with this email already exists.' using errcode = '23505';
end;
$$;

create or replace function public.mark_drawer_delivered(
  p_drawer_id uuid, p_note text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  d public.drawer%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  select * into d from public.drawer where id = p_drawer_id for update;
  if not found then
    raise exception 'Drawer not found.' using errcode = 'P0002';
  end if;
  -- Repeated delivery events are allowed (re-delivery after rework);
  -- the timeline shows them in order. drawer.status (ops enum) untouched.
  insert into public.drawer_event
    (drawer_id, revision, event_type, actor_name, actor_role, note)
  values
    (p_drawer_id, coalesce(d.current_revision, 0), 'delivered', 'TidyTool', 'staff',
     nullif(btrim(coalesce(p_note, '')), ''));
  return json_build_object('ok', true, 'drawer_id', p_drawer_id);
end;
$$;

-- Lock down: guarded internally, but don't even expose to anon.
revoke execute on function public.get_admin_pipeline()                        from public, anon;
revoke execute on function public.get_admin_orphan_orders()                   from public, anon;
revoke execute on function public.get_admin_customers()                       from public, anon;
revoke execute on function public.assign_order_to_customer(uuid, uuid)        from public, anon;
revoke execute on function public.admin_create_customer(text, text, text)     from public, anon;
revoke execute on function public.mark_drawer_delivered(uuid, text)           from public, anon;
grant execute on function public.get_admin_pipeline()                    to authenticated;
grant execute on function public.get_admin_orphan_orders()               to authenticated;
grant execute on function public.get_admin_customers()                   to authenticated;
grant execute on function public.assign_order_to_customer(uuid, uuid)    to authenticated;
grant execute on function public.admin_create_customer(text, text, text) to authenticated;
grant execute on function public.mark_drawer_delivered(uuid, text)       to authenticated;

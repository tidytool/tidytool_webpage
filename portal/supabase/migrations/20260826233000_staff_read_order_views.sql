-- Staff read access to the admin order views.
--
-- WHAT
--   Re-gates the three order-view getters from is_admin() to is_staff()
--   (is_staff() is true for admins too, so nothing changes for admins):
--     1. get_admin_pipeline()      — body from 20260706000000, unchanged
--     2. get_admin_orders(...)     — body from 20260802120000, unchanged
--     3. get_admin_order_detail()  — body from 20260802120000, unchanged
--   ONLY the guard line changes in each. get_status_pipeline, get_work_queue
--   and get_quotes_for_order already allow staff; every mutation RPC and the
--   remaining get_admin_* functions (customers, orphans, audit) stay
--   admin-only.
--
-- WHY
--   Sam wants employees (the 'staff' role) to see progressing orders and
--   their files in the portal without getting the admin role — admin would
--   also expose the Employees tab and role management. The portal ships
--   matching UI in the same branch: staff see Pipeline / Queue / Orders as
--   read-only (no bulk tools, no Organize, no quotes/edit modals), and the
--   admin-only tabs are hidden + redirect. RLS already lets staff read
--   "order" and drawer rows, so this closes the gap at the RPC layer only.
--
-- ROLLBACK
--   Re-run the previous definitions: get_admin_pipeline from
--   20260706000000_portal_durable_model_and_admin.sql, get_admin_orders and
--   get_admin_order_detail from 20260802120000_admin_orders_design_progress.sql
--   (all three are is_admin()-guarded there; signatures are identical, so a
--   plain re-run replaces these versions).
--
-- VERIFY (dev or branch, signed in as a staff-only user, e.g. via the portal)
--   select count(*) from public.get_admin_pipeline();      -- rows, not 42501
--   select count(*) from public.get_admin_orders();        -- rows, not 42501
--   select public.get_admin_order_detail('<order-id>');    -- json, not 42501
--   -- and as a plain customer (no roles): all three still raise 42501.
--
-- Signatures are unchanged, so CREATE OR REPLACE keeps the existing grants
-- (authenticated / service_role) and no PostgREST schema reload is needed.

-- 1) get_admin_pipeline -------------------------------------------------------
create or replace function public.get_admin_pipeline()
returns table (
  drawer_id uuid, nickname text, status drawer_status,
  customer_approval_status text, current_revision integer,
  approved_by text, approved_at timestamptz,
  order_id uuid, project_name text, customer_id uuid,
  customer_name text, customer_email text, created_at timestamptz
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Staff or admins only.' using errcode = '42501';
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

-- 2) get_admin_orders ---------------------------------------------------------
create or replace function public.get_admin_orders(
  p_search text default null,
  p_organization_id uuid default null,
  p_email text default null,
  p_from timestamptz default null,
  p_to   timestamptz default null
) returns table (
  order_id uuid, created_at timestamptz, customer_name text, customer_email text,
  project_name text, location text, notes text, drawer_count bigint,
  total_price bigint, customer_id uuid, organization_id uuid, organization_name text,
  drawer_rows bigint,
  drawers_designed bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Staff or admins only.' using errcode = '42501';
  end if;
  return query
    select o.id, o.created_at,
           coalesce(c.name,  o.customer_name),
           coalesce(c.email, o.customer_email),
           o.project_name, o.location, o.notes, o.drawer_count, o.total_price,
           o.customer_id, o.organization_id, g.name,
           coalesce(dc.total, 0), coalesce(dc.designed, 0)
      from public."order" o
      left join public.customer c on c.id = o.customer_id
      left join public.organization g on g.id = o.organization_id
      left join lateral (
        select count(*) as total,
               count(*) filter (
                 where coalesce(public.status_sort('drawer', d.stage), 0) >= 40
               ) as designed
          from public.drawer d
         where d.order_id = o.id
      ) dc on true
     where (p_search is null or btrim(p_search) = ''
            or coalesce(c.name,  o.customer_name, '') ilike '%'||btrim(p_search)||'%'
            or coalesce(c.email, o.customer_email,'') ilike '%'||btrim(p_search)||'%'
            or coalesce(o.project_name,'') ilike '%'||btrim(p_search)||'%'
            or coalesce(o.notes,'') ilike '%'||btrim(p_search)||'%')
       and (p_organization_id is null or o.organization_id = p_organization_id)
       and (p_email is null or btrim(p_email) = ''
            or coalesce(c.email, o.customer_email,'') ilike '%'||btrim(p_email)||'%')
       and (p_from is null or o.created_at >= p_from)
       and (p_to   is null or o.created_at <  p_to)
     order by o.created_at desc;
end;
$$;

-- 3) get_admin_order_detail ---------------------------------------------------
create or replace function public.get_admin_order_detail(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v json;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  select json_build_object(
    'order', to_jsonb(o),
    'customer', to_jsonb(c),
    'organization', to_jsonb(g),
    'boxes', coalesce((select json_agg(json_build_object('id', b.id, 'label', b.label, 'quantity', b.quantity, 'created_at', b.created_at) order by b.created_at) from public.box b where b.order_id = o.id), '[]'::json),
    'drawers', coalesce((select json_agg(json_build_object('id', d.id, 'nickname', d.nickname, 'status', d.status, 'customer_approval_status', d.customer_approval_status, 'current_revision', d.current_revision, 'photo_url', d.photo_url, 'point_cloud_url', d.point_cloud_url, 'design_preview_url', d.design_preview_url, 'dxf_url', d.dxf_url, 'box_id', d.box_id, 'quantity', d.quantity, 'tier', d.tier, 'stage', d.stage, 'stage_label', sd.label, 'stage_sort', sd.sort_order, 'created_at', d.created_at) order by d.created_at) from public.drawer d left join public.status_def sd on sd.domain = 'drawer' and sd.code = d.stage where d.order_id = o.id), '[]'::json)
  ) into v
  from public."order" o
  left join public.customer c on c.id = o.customer_id
  left join public.organization g on g.id = o.organization_id
  where o.id = p_order_id;
  if v is null then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  return v;
end; $$;

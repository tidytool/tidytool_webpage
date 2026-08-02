-- 20260802120000_admin_orders_design_progress
--
-- WHAT
--   1. get_admin_orders gains `drawers_designed` — how many of the order's
--      drawer rows are at stage "designed" or later (status_def sort_order
--      >= 40). Paired with the existing `drawers_designed <= drawer_rows`
--      total, the admin orders list can show percent design-complete vs
--      percent awaiting design per order.
--   2. get_admin_order_detail's drawers payload gains `stage`, `stage_label`
--      and `stage_sort` so the order detail page can show the same progress
--      summary and stage-accurate chips (it currently only carries the
--      legacy `status` enum).
--
-- WHY
--   Sam needs at-a-glance design progress on the admin order views, plus DXF
--   downloads per order (frontend change riding on the same detail payload).
--   Counting is over drawer rows (design work units), deliberately ignoring
--   box.quantity / drawer.quantity — a design is done once per drawer row.
--   "Design complete" is defined by the status backbone (stage sort >= 40,
--   i.e. designed/qc_passed/awaiting_approval/approved/in_production/cut/
--   ready/delivered), NOT by dxf_url presence: pre-design drawers can already
--   have a DXF uploaded. A null/unknown stage counts as awaiting design.
--
-- ROLLBACK
--   Re-run the previous definitions: get_admin_orders from
--   20260707000000_admin_crm.sql (drop this version first — the return table
--   differs), get_admin_order_detail from 20260730120000_product_tiers.sql.
--
-- VERIFY (branch)
--   select order_id, drawer_rows, drawers_designed from get_admin_orders();
--     -- drawers_designed <= drawer_rows on every row; all other columns and
--     -- filter args behave exactly as before.
--   select json_array_length(get_admin_order_detail(<id>)->'drawers');
--     -- each element now carries stage / stage_label / stage_sort.

-- 1) get_admin_orders --------------------------------------------------------
-- Return type gains a column, which CREATE OR REPLACE cannot do — drop first
-- (precedent: 20260705173519 dropped get_admin_customers() for the same reason).
drop function if exists public.get_admin_orders(text, uuid, text, timestamptz, timestamptz);

create function public.get_admin_orders(
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
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
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

revoke execute on function public.get_admin_orders(text, uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_admin_orders(text, uuid, text, timestamptz, timestamptz) to authenticated;

-- 2) get_admin_order_detail --------------------------------------------------
-- Returns json, so a plain replace. Body identical to 20260730120000 except the
-- drawers payload gains stage / stage_label / stage_sort via status_def.
create or replace function public.get_admin_order_detail(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare v json;
begin
  if not public.is_admin() then raise exception 'Admins only.' using errcode = '42501'; end if;
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

revoke execute on function public.get_admin_order_detail(uuid) from anon, public;
grant execute on function public.get_admin_order_detail(uuid) to authenticated, service_role;

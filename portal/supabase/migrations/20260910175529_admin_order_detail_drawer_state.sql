-- Expose drawer state to the admin order-detail view (2026-09-10).
-- Additive: the drawer objects in get_admin_order_detail gain 'state' and
-- 'state_reason' so the new cancel/hold controls can render current state
-- and skip already-cancelled drawers. Everything else is identical to
-- 20260826233000_staff_read_order_views.
--
-- APPLIED to prod 2026-09-10 via MCP (version 20260910175529).

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
    'drawers', coalesce((select json_agg(json_build_object('id', d.id, 'nickname', d.nickname, 'status', d.status, 'customer_approval_status', d.customer_approval_status, 'current_revision', d.current_revision, 'photo_url', d.photo_url, 'point_cloud_url', d.point_cloud_url, 'design_preview_url', d.design_preview_url, 'dxf_url', d.dxf_url, 'box_id', d.box_id, 'quantity', d.quantity, 'tier', d.tier, 'stage', d.stage, 'stage_label', sd.label, 'stage_sort', sd.sort_order, 'state', d.state, 'state_reason', d.state_reason, 'created_at', d.created_at) order by d.created_at) from public.drawer d left join public.status_def sd on sd.domain = 'drawer' and sd.code = d.stage where d.order_id = o.id), '[]'::json)
  ) into v
  from public."order" o
  left join public.customer c on c.id = o.customer_id
  left join public.organization g on g.id = o.organization_id
  where o.id = p_order_id;
  if v is null then raise exception 'Order not found.' using errcode = 'P0002'; end if;
  return v;
end; $$;

notify pgrst, 'reload schema';

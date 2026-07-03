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
  select
    d.id,
    d.nickname,
    d.status,
    d.customer_approval_status,
    d.design_preview_url,
    d.photo_url,
    d.dimensions,
    d.order_id,
    o.project_name,
    d.created_at
  from public.drawer d
  join public."order" o on o.id = d.order_id
  where auth.email() is not null
    and lower(o.customer_email) = lower(auth.email())
  order by d.created_at desc;
$$;

revoke all on function public.get_my_drawers() from public, anon;
grant execute on function public.get_my_drawers() to authenticated;
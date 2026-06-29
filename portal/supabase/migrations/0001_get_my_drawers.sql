-- Portal dashboard data source.
--
-- Why this exists: there is no clean link yet between auth.users and a customer's
-- orders. drawer.created_by is the tidyCAM *operator*, and the customer table is unused.
-- Until that's modeled properly, we scope a logged-in customer to their drawers by
-- matching order.customer_email to the authenticated user's email.
--
-- SECURITY DEFINER + a hard auth.email() filter means the anon/publishable key cannot
-- read arbitrary rows: a caller only ever gets drawers on orders that carry their own
-- verified email. Internal columns (dxf_url, point_cloud_url, created_by, order notes)
-- are deliberately not selected.
--
-- REVIEW BEFORE APPLYING. Confirm:
--   1. order.customer_email is populated for real orders (tidyCAM / intake writes it).
--   2. A signed-in user only ever sees their own drawers (test with two accounts).

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

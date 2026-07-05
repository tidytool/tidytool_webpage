-- ============================================================================
-- T3.5c — Org list RPC + richer customer rows
--
-- WHAT
--   1. get_admin_customers v2 — adds phone (the edit form was rendering an
--      always-empty phone field), order_count, and has_login so the UI can
--      show/disable delete per the admin_delete_customer guards.
--      Return type changes, so DROP + CREATE (not CREATE OR REPLACE).
--   2. get_admin_organizations — all orgs with customer/order counts. Orgs
--      with zero customers never appeared before (the UI derived orgs from
--      customers), yet those are exactly the deletable ones.
--
-- ROLLBACK: drop get_admin_organizations; restore get_admin_customers from
--   the T3 migration (20260706000000).
-- ============================================================================

drop function if exists public.get_admin_customers();
create function public.get_admin_customers()
returns table (
  customer_id uuid, name text, email text, phone text,
  organization_id uuid, organization_name text,
  order_count bigint, has_login boolean
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select c.id, c.name, c.email, c.phone, c.organization_id, g.name,
           (select count(*) from public."order" o where o.customer_id = c.id),
           (c.auth_user_id is not null)
      from public.customer c
      left join public.organization g on g.id = c.organization_id
     order by coalesce(c.name, c.email);
end;
$$;

create or replace function public.get_admin_organizations()
returns table (
  organization_id uuid, name text, customer_count bigint, order_count bigint
)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select g.id, g.name,
           (select count(*) from public.customer c where c.organization_id = g.id),
           (select count(*) from public."order" o where o.organization_id = g.id)
      from public.organization g
     order by g.name;
end;
$$;

revoke execute on function public.get_admin_customers()     from public, anon;
revoke execute on function public.get_admin_organizations() from public, anon;
grant execute on function public.get_admin_customers()     to authenticated;
grant execute on function public.get_admin_organizations() to authenticated;

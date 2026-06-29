-- Security hardening: remove blanket anon/public read access.
--
-- Problem: both `drawer` and `employee` have a policy "Enable read access for all users"
-- (role public, USING true). The anon/publishable key is embedded in the public website,
-- so anyone can read EVERY column of EVERY drawer (incl. internal dxf_url, point_cloud_url,
-- created_by, order_id) and all employee PII (names, phones).
--
-- Fix:
--   1. Add get_public_drawer(id): a SECURITY DEFINER accessor returning only public-safe
--      drawer fields, so the public QR page (docs/drawer.html) keeps working without a
--      blanket table policy.
--   2. Drop the blanket policy on `drawer`. Authenticated reads are unaffected — they go
--      through the existing "drawers select" policy (is_admin() OR created_by = auth.uid()).
--      The portal/approval RPCs are SECURITY DEFINER and bypass RLS, so they're unaffected.
--   3. Replace the blanket policy on `employee` with an authenticated-only read (closes the
--      anon PII exposure). NOTE: this still lets any logged-in user read employee rows;
--      tightening to is_admin() is a recommended follow-up once we confirm no non-admin
--      staff/tidyCAM flow needs employee reads.
--
-- DEPLOY ORDER (zero downtime): apply step 1 to prod first (additive, safe) and deploy the
-- updated docs/drawer.html (which calls the RPC), THEN apply steps 2-3.

-- 1. Public-safe drawer accessor ------------------------------------------------------------
create or replace function public.get_public_drawer(p_id uuid)
returns table (
  nickname text,
  photo_url text,
  dimensions json,
  status drawer_status
)
language sql
security definer
stable
set search_path = public
as $$
  select d.nickname, d.photo_url, d.dimensions, d.status
  from public.drawer d
  where d.id = p_id;
$$;

revoke all on function public.get_public_drawer(uuid) from public;
grant execute on function public.get_public_drawer(uuid) to anon, authenticated;

-- 2. Remove blanket read on drawer ----------------------------------------------------------
drop policy if exists "Enable read access for all users" on public.drawer;

-- 3. Restrict employee reads to authenticated -----------------------------------------------
drop policy if exists "Enable read access for all users" on public.employee;
create policy "employee_select_authenticated"
  on public.employee
  for select
  to authenticated
  using (true);

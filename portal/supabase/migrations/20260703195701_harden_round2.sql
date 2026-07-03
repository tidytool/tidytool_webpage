-- Security hardening, round 2 (see portal/supabase/migrations/0003_harden_round2.sql)

-- 1. is_admin(): remove anonymous execution
revoke execute on function public.is_admin() from anon;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 2. drawer INSERT: drop the loose duplicate; keep drawer_insert_authenticated
drop policy if exists "drawers insert" on public.drawer;

-- 3. drawer UPDATE: drop the inert narrow duplicate; keep "drawers update"
drop policy if exists "drawer_update_authenticated" on public.drawer;

-- 4. drawer-assets bucket: stop whole-bucket listing by any signed-in user
drop policy if exists "auth read drawer-assets" on storage.objects;
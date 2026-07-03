-- Security hardening: remove blanket anon/public read access.
-- Step 1 (get_public_drawer) was applied 2026-06-28; re-applying is idempotent.

-- 1. Public-safe drawer accessor
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

-- 2. Remove blanket read on drawer
drop policy if exists "Enable read access for all users" on public.drawer;

-- 3. Restrict employee reads to authenticated
drop policy if exists "Enable read access for all users" on public.employee;
drop policy if exists "employee_select_authenticated" on public.employee;
create policy "employee_select_authenticated"
  on public.employee
  for select
  to authenticated
  using (true);
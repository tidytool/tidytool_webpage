-- Additive + safe: new public-safe accessor. Does NOT change existing access yet.
-- The blanket-policy drops are applied separately, AFTER the updated docs/drawer.html
-- (which calls this RPC) is deployed live. See 0002_harden_anon_reads.sql.
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
-- Site address + saved round-trip distance on the order, so mileage stops being
-- hand-typed per quote: enter it once on the order, the quote form pre-fills.
-- Address is also the basis for a future automated distance lookup.
--
-- ADDITIVE + a NEW dedicated RPC (admin_set_order_site) — admin_update_order is
-- left untouched (changing its arg count risks PostgREST overload ambiguity).
-- Safe to pre-apply: existing code never calls the new RPC and the columns are
-- nullable with no default.

alter table public."order"
  add column site_address     text,
  add column round_trip_miles numeric;
comment on column public."order".site_address is
  'Customer scan/delivery site address (free text). Basis for a future distance lookup.';
comment on column public."order".round_trip_miles is
  'Saved round-trip driving distance (miles) shop→site. Pre-fills the quote form so miles are entered once per order, not re-typed per quote.';

-- Dedicated setter with SET semantics (what the form shows is what it saves;
-- blank clears). Guarded + audited like the other admin RPCs.
create or replace function public.admin_set_order_site(
  p_order_id         uuid,
  p_site_address     text,
  p_round_trip_miles numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_before public."order"%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  if p_round_trip_miles is not null and p_round_trip_miles < 0 then
    raise exception 'round_trip_miles must be >= 0.' using errcode = '22000';
  end if;
  select * into v_before from public."order" where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  update public."order"
     set site_address     = nullif(btrim(coalesce(p_site_address, '')), ''),
         round_trip_miles = p_round_trip_miles
   where id = p_order_id;

  perform public._admin_audit('set_order_site', 'order', p_order_id,
    to_jsonb(v_before),
    jsonb_build_object('site_address', nullif(btrim(coalesce(p_site_address, '')), ''),
                       'round_trip_miles', p_round_trip_miles));
end;
$$;
revoke all on function public.admin_set_order_site(uuid, text, numeric) from public, anon;
grant execute on function public.admin_set_order_site(uuid, text, numeric) to authenticated, service_role;

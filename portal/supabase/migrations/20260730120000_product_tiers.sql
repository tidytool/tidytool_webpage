-- Product tiers (Sam, 2026-07-30): Essential (dual-color cut, $20/sqft) /
-- Professional (engraving, $24/sqft) / Premium (silk screen + protective top
-- layer, $28/sqft). Tier is set PER DRAWER — orders can mix tiers.
--
-- ⚠ HIGH-RISK per CLAUDE.md: production schema + pricing change. Sam reviews
--   before apply. NOTE the pricing_config insert changes what NEW quotes charge
--   for professional/premium-tagged drawers (existing quotes keep their config
--   row). Deploy order is free: old engine on the v3 config still reads
--   rate_cents_per_sqft ($20 flat); new engine on the v2 config prices all
--   tiers at the base rate with a warning. Nothing breaks either way.

-- 1) drawer.tier — additive, defaults essential (all existing drawers).
alter table public.drawer add column if not exists tier text not null default 'essential'
  constraint drawer_tier_check check (tier in ('essential','professional','premium'));

comment on column public.drawer.tier is
  'Product tier: essential (dual-color cut) | professional (engraving) | premium (silk screen + protective top layer). Set per drawer; priced by the quoting engine via pricing_config tier rates.';

-- 2) pricing_config v3 — per-tier rates. Versioned, NOT an edit: deactivate the
--    active row and insert a new active one, so historical quotes keep the
--    exact config that priced them. rate_cents_per_sqft stays = essential so
--    pre-tier engine builds keep working against this config.
--    Keep this JSON in sync with DEFAULT_PRICING_CONFIG in portal/src/lib/pricing/config.ts.
update public.pricing_config set active = false where active;

insert into public.pricing_config (label, active, config) values (
  'Tiers v3 2026-07-30 — Essential $20 / Professional $24 / Premium $28 per sqft; $100 design + $1.25/mi travel both trips',
  true,
  '{
    "version": 3,
    "currency": "USD",
    "product": {
      "rate_cents_per_sqft": 2000,
      "tier_rates_cents_per_sqft": { "essential": 2000, "professional": 2400, "premium": 2800 },
      "thickness_multipliers": { "0.5": 1.0 },
      "default_thickness_in": 0.5,
      "default_thickness_multiplier": 1.0
    },
    "minimums": { "per_drawer_cents": 4000, "per_order_cents": 25000 },
    "services": {
      "measurement_design": { "label": "On-site Measurement & Design", "base_cents": 10000, "travel_cents_per_mile": 125 },
      "delivery_install":   { "label": "Delivery, Installation & Test Fit", "travel_cents_per_mile": 125 }
    },
    "upgrades": {},
    "costs": {
      "mileage_cents_per_round_trip_mile": 70,
      "driving_labor_cents_per_hour": 2000,
      "scanning_labor_cents_per_hour": 2000,
      "install_labor_cents_per_hour": 2000,
      "scanning_minutes_per_sqft": 5,
      "default_trips": 2
    },
    "margin": { "target": 0.6 },
    "rounding": { "line": "cent", "total": "cent" }
  }'::jsonb
);

-- 3) admin_set_drawer_tier — audited, staff-guarded, same pattern as
--    admin_set_drawer_quantity.
create or replace function public.admin_set_drawer_tier(p_drawer_id uuid, p_tier text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_before text;
begin
  if not public.is_staff() then raise exception 'Staff or admins only.' using errcode = '42501'; end if;
  if p_tier is null or p_tier not in ('essential','professional','premium') then
    raise exception 'Tier must be essential, professional, or premium.' using errcode = '22000';
  end if;
  select tier into v_before from public.drawer where id = p_drawer_id for update;
  if not found then raise exception 'Drawer not found.' using errcode = 'P0002'; end if;
  if v_before = p_tier then return; end if;
  update public.drawer set tier = p_tier where id = p_drawer_id;
  perform public._admin_audit('set_drawer_tier', 'drawer', p_drawer_id,
    jsonb_build_object('drawer_id', p_drawer_id, 'tier', v_before),
    jsonb_build_object('drawer_id', p_drawer_id, 'tier', p_tier));
end; $$;

revoke execute on function public.admin_set_drawer_tier(uuid, text) from anon, public;
grant execute on function public.admin_set_drawer_tier(uuid, text) to authenticated, service_role;

-- 4) get_admin_order_detail — drawers payload gains 'tier'. Body otherwise
--    identical to the current prod definition (boxes migration shape).
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
    'drawers', coalesce((select json_agg(json_build_object('id', d.id, 'nickname', d.nickname, 'status', d.status, 'customer_approval_status', d.customer_approval_status, 'current_revision', d.current_revision, 'photo_url', d.photo_url, 'point_cloud_url', d.point_cloud_url, 'design_preview_url', d.design_preview_url, 'dxf_url', d.dxf_url, 'box_id', d.box_id, 'quantity', d.quantity, 'tier', d.tier, 'created_at', d.created_at) order by d.created_at) from public.drawer d where d.order_id = o.id), '[]'::json)
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

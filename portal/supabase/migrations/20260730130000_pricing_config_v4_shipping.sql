-- Pricing config v4 (Sam, 2026-07-30) — three changes to the quote logic:
--   1. Delivery & Installation = expected SHIPPING cost of the materials:
--      $15 flat + $1.50/sqft of PHYSICAL foam (design sqft × copies).
--      No more delivery-visit travel; internal cost model drops to 1 trip.
--   2. NO per-drawer minimum (per_drawer_cents = 0) — drawers price purely
--      by sqft × tier rate. The $250 order minimum remains the backstop.
--   3. Measurement & Design loses the $100 design base (base_cents = 0) —
--      the line is scan-visit travel only (round-trip miles × $1.25).
--
-- ⚠ PRICING CHANGE + DEPLOY ORDER MATTERS THIS TIME:
--   Apply this AFTER the v4 engine code is deployed. The old engine reads
--   delivery travel_cents_per_mile (0 here) and would price delivery at $0 —
--   it won't error, but it undercharges shipping. The new engine on the old
--   v3 config prices the old way (travel model), so code-first is safe.
--
-- Versioned, NOT an edit: deactivate the current active row and INSERT a new
-- active one, so historical quotes keep the exact config that priced them.
-- Keep this JSON in sync with DEFAULT_PRICING_CONFIG in portal/src/lib/pricing/config.ts.

update public.pricing_config set active = false where active;

insert into public.pricing_config (label, active, config) values (
  'v4 2026-07-30 — shipped delivery ($15 + $1.50/sqft physical), no drawer floor, no design base; tiers $20/$24/$28',
  true,
  '{
    "version": 4,
    "currency": "USD",
    "product": {
      "rate_cents_per_sqft": 2000,
      "tier_rates_cents_per_sqft": { "essential": 2000, "professional": 2400, "premium": 2800 },
      "thickness_multipliers": { "0.5": 1.0 },
      "default_thickness_in": 0.5,
      "default_thickness_multiplier": 1.0
    },
    "minimums": { "per_drawer_cents": 0, "per_order_cents": 25000 },
    "services": {
      "measurement_design": { "label": "On-site Measurement & Design", "base_cents": 0, "travel_cents_per_mile": 125 },
      "delivery_install":   { "label": "Delivery & Installation", "travel_cents_per_mile": 0, "shipping_base_cents": 1500, "shipping_cents_per_sqft": 150 }
    },
    "upgrades": {},
    "costs": {
      "mileage_cents_per_round_trip_mile": 70,
      "driving_labor_cents_per_hour": 2000,
      "scanning_labor_cents_per_hour": 2000,
      "install_labor_cents_per_hour": 2000,
      "scanning_minutes_per_sqft": 5,
      "default_trips": 1
    },
    "margin": { "target": 0.6 },
    "rounding": { "line": "cent", "total": "cent" }
  }'::jsonb
);

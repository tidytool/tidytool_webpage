-- Pricing config v2 — services become travel-priced (Sam, 2026-07-24).
--
-- $20/sqft now covers on-site labor (scanning + install/test-fit). Service lines:
--   On-site Measurement & Design      = $100 base + round-trip miles × $1.25 (scan visit)
--   Delivery, Installation & Test Fit =              round-trip miles × $1.25 (delivery visit)
-- Travel billed on BOTH visits. Foam priced per PHYSICAL drawer (box.qty × drawer.qty).
--
-- ⚠ COORDINATED DEPLOY — the config SHAPE changed
--   (services.{base_cents,travel_cents_per_mile} instead of {included,price_cents}).
--   The Stage 2 engine (portal/src/lib/pricing/*) MUST be deployed when this is
--   applied: the v1 engine cannot read a v2 config, and a v2 engine reading the v1
--   config errors gracefully. Apply this together with the Stage 2 code deploy.
--
-- Versioned, NOT an edit (safeguard 4): deactivate the current active row and INSERT
-- a new active one, so historical quotes keep the exact config that priced them.
-- Keep this JSON in sync with DEFAULT_PRICING_CONFIG in portal/src/lib/pricing/config.ts.

update public.pricing_config set active = false where active;

insert into public.pricing_config (label, active, config) values (
  'Priced services v2 2026-07-24 — $20/sqft (labor incl.), $100 design + $1.25/mi travel (both trips)',
  true,
  '{
    "version": 2,
    "currency": "USD",
    "product": {
      "rate_cents_per_sqft": 2000,
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

/**
 * Per-quote override tests: sanitize + merge + engine round-trip.
 * Run:  npm run test:pricing
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRICING_CONFIG,
  applyConfigOverrides,
  parsePricingConfig,
  sanitizeOverrides,
} from "./config";
import { computeQuote, type QuoteDrawerInput } from "./engine";

const cfg = DEFAULT_PRICING_CONFIG;
const INPUTS = { round_trip_miles: 30, drive_hours_per_trip: 0.75, install_hours: 0 };
const FOUR_SQFT: QuoteDrawerInput = {
  id: "d",
  nickname: "d",
  dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" },
  tier: "professional",
};
const line = (q: ReturnType<typeof computeQuote>, kind: string) => q.lines.find((l) => l.kind === kind)!;

test("sanitizeOverrides: keeps valid cents, drops junk keys/values/tiers", () => {
  const out = sanitizeOverrides({
    tier_rates_cents_per_sqft: { professional: 2200, deluxe: 999, essential: -5, premium: 30.5 },
    shipping_base_cents: 2000,
    shipping_cents_per_sqft: "nope",
    made_up_key: 123,
    per_order_min_cents: 0,
  });
  assert.deepEqual(out, {
    tier_rates_cents_per_sqft: { professional: 2200 },
    shipping_base_cents: 2000,
    per_order_min_cents: 0,
  });
  assert.deepEqual(sanitizeOverrides(null), {});
  assert.deepEqual(sanitizeOverrides("x"), {});
});

test("applyConfigOverrides: merges without mutating the source config", () => {
  const before = JSON.stringify(cfg);
  const merged = applyConfigOverrides(cfg, {
    tier_rates_cents_per_sqft: { professional: 2200 },
    shipping_base_cents: 0,
    per_order_min_cents: 10000,
  });
  assert.equal(JSON.stringify(cfg), before); // untouched
  assert.equal(merged.product.tier_rates_cents_per_sqft?.professional, 2200);
  assert.equal(merged.product.tier_rates_cents_per_sqft?.premium, 2800); // others kept
  assert.equal(merged.services.delivery_install.shipping_base_cents, 0);
  assert.equal(merged.services.delivery_install.shipping_cents_per_sqft, 150); // pair completed from config
  assert.equal(merged.minimums.per_order_cents, 10000);
  // essential override keeps the legacy fallback aligned:
  const ess = applyConfigOverrides(cfg, { tier_rates_cents_per_sqft: { essential: 1800 } });
  assert.equal(ess.product.rate_cents_per_sqft, 1800);
  // merged config still passes the validator:
  parsePricingConfig(JSON.parse(JSON.stringify(merged)));
});

test("overridden tier rate + shipping + order min flow through a real quote", () => {
  const merged = applyConfigOverrides(cfg, {
    tier_rates_cents_per_sqft: { professional: 2200 },
    shipping_base_cents: 1000,
    shipping_cents_per_sqft: 100,
    per_order_min_cents: 0, // kill the backstop for this quote
  });
  const q = computeQuote([FOUR_SQFT], INPUTS, merged);
  assert.equal(line(q, "product").unit_price_cents, 4 * 2200); // custom $22/sqft
  assert.equal(line(q, "delivery_install").amount_cents, 1000 + 400); // $10 + 4 sqft × $1
  assert.equal(q.lines.some((l) => l.kind === "min_order_adjustment"), false); // min disabled
  assert.equal(q.total_cents, 3750 + 8800 + 1400);
});

test("re-enabling the per-drawer floor via override floors the copy price", () => {
  const merged = applyConfigOverrides(cfg, { per_drawer_min_cents: 4000 });
  const tiny: QuoteDrawerInput = {
    id: "t",
    nickname: "t",
    dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" }, // 1 sqft → $20 raw
  };
  const p = line(computeQuote([tiny], INPUTS, merged), "product");
  assert.equal(p.unit_price_cents, 4000);
  assert.equal(p.meta.drawer_minimum_applied, true);
});

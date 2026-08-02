/**
 * Quoting-engine unit tests (v4 pricing: tiers + shipped delivery).
 *
 * Run:  npm run test:pricing
 *
 * Dimension fixtures mirror REAL production `drawer.dimensions` shapes.
 * Pricing model under test (v4, Sam 2026-07-30): tier rate × sqft per PHYSICAL
 * copy, NO per-drawer floor; On-site Measurement & Design = round-trip miles ×
 * $1.25 (no design base); Delivery & Installation = estimated shipping
 * ($15 + $1.50/sqft of physical foam); $250 order minimum retained.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeQuote, type QuoteDrawerInput, type QuoteInputs } from "./engine";
import { DEFAULT_PRICING_CONFIG, parsePricingConfig, type PricingConfig } from "./config";
import { isNormalizeFailure, normalizeDrawerDimensions } from "./normalize";

const cfg = DEFAULT_PRICING_CONFIG;

// miles 30 → measurement = 30×125 = 3750 (no design base since v4).
// Shipping for one legacy drawer copy: 1500 + round(2.4898 sqft × 150) = 1873.
const INPUTS: QuoteInputs = { round_trip_miles: 30, drive_hours_per_trip: 0.75, install_hours: 1 };
const MEASURE_30 = 3750;
const SHIP_LEGACY_1 = 1873;
const SHIP_EMPTY = 1500; // flat shipping base with zero foam sqft

const legacyDrawer = (id: string, copies?: number): QuoteDrawerInput => ({
  id,
  nickname: `legacy-${id}`,
  dimensions: { length: 19.25, width: 18.625, thickness: 0.5, units: "in" },
  ...(copies != null ? { copies } : {}),
}); // area 2.4898 sqft → per-copy $49.80 (no floor since v4)

const scannedDrawer: QuoteDrawerInput = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  nickname: "scanned",
  dimensions: { unit: "feetDecimal", width: 1.2172, height: 1.6699, thickness: "oneHalf" },
};

const line = (q: ReturnType<typeof computeQuote>, kind: string) => q.lines.find((l) => l.kind === kind)!;

// ---- normalizer (unchanged) -------------------------------------------------
test("normalizer: legacy inches + feetDecimal + mm + thickness-object", () => {
  const a = normalizeDrawerDimensions({ length: 19.25, width: 18.625, thickness: 0.5, units: "in" });
  assert.ok(!isNormalizeFailure(a) && a.thickness_in === 0.5);
  const b = normalizeDrawerDimensions(scannedDrawer.dimensions);
  assert.ok(!isNormalizeFailure(b) && b.thickness_in === 0.5);
  const c = normalizeDrawerDimensions({ width: 20, length: 20, units: "in", thickness: { value: 0.75, unit: "in" } });
  assert.ok(!isNormalizeFailure(c) && c.thickness_in === 0.75);
  assert.ok(isNormalizeFailure(normalizeDrawerDimensions({ width: 19, length: 18, units: "ft" }))); // unit bug
});

// ---- service lines: scan travel + shipped delivery (v4) ---------------------
test("measurement is travel-only; delivery is a shipping estimate", () => {
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  const m = line(q, "measurement_design");
  const d = line(q, "delivery_install");
  assert.equal(m.amount_cents, MEASURE_30); // 30 × $1.25, no design base
  assert.equal(m.meta.base_cents, 0);
  assert.equal(m.description.includes("design"), false); // $0 base never rendered
  assert.equal(d.amount_cents, SHIP_LEGACY_1); // $15 + 2.4898 sqft × $1.50
  assert.equal(d.meta.shipping_base_cents, 1500);
  assert.match(d.description, /estimated shipping/);
  assert.equal(d.included, false);
});

test("travel is billed ONLY on the scan visit; shipping ignores miles", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 80 }, cfg);
  assert.equal(line(q, "measurement_design").meta.travel_cents, 80 * 125);
  assert.equal(line(q, "delivery_install").amount_cents, SHIP_LEGACY_1); // unchanged by miles
  assert.equal(line(q, "delivery_install").meta.travel_cents, undefined);
});

test("shipping scales with PHYSICAL foam (copies), not design count", () => {
  const one = computeQuote([legacyDrawer("d", 1)], INPUTS, cfg);
  const four = computeQuote([legacyDrawer("d", 4)], INPUTS, cfg);
  assert.equal(line(one, "delivery_install").amount_cents, 1873); // 1500 + round(2.4898×150)
  assert.equal(line(four, "delivery_install").amount_cents, 2994); // 1500 + round(9.9592×150)
});

test("zero miles → measurement is $0 (local pickup); shipping unaffected", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 0 }, cfg);
  assert.equal(line(q, "measurement_design").amount_cents, 0);
  assert.equal(line(q, "delivery_install").amount_cents, SHIP_LEGACY_1);
});

// ---- foam per physical copy -------------------------------------------------
test("foam is per-copy at $20/sqft; copies multiply, design does NOT", () => {
  const one = computeQuote([legacyDrawer("d", 1)], INPUTS, cfg);
  const three = computeQuote([legacyDrawer("d", 3)], INPUTS, cfg);
  const p1 = line(one, "product");
  const p3 = line(three, "product");
  assert.equal(p1.amount_cents, 4980); // 1 copy
  assert.equal(p1.qty, 1);
  assert.equal(p1.unit_price_cents, 4980); // per-copy
  assert.equal(p3.amount_cents, 4980 * 3); // 3 copies
  assert.equal(p3.qty, 3);
  assert.equal(p3.meta.copies, 3);
  assert.match(p3.description, /× 3$/);
  // design charged once regardless of copies:
  assert.equal(line(one, "measurement_design").amount_cents, line(three, "measurement_design").amount_cents);
});

test("NO per-drawer floor (v4): a tiny drawer prices purely by sqft", () => {
  const small: QuoteDrawerInput = {
    id: "s",
    nickname: "small",
    dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" }, // 1 sqft → $20/copy, no floor
    copies: 2,
  };
  const p = line(computeQuote([small], INPUTS, cfg), "product");
  assert.equal(p.unit_price_cents, 2000); // exactly sqft × rate
  assert.equal(p.amount_cents, 4000); // × 2 copies
  assert.equal(p.meta.drawer_minimum_applied, false);
});

// ---- totals / order minimum -------------------------------------------------
test("line order: measurement → products → delivery → [min adj]", () => {
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  assert.deepEqual(q.lines.map((l) => l.kind), [
    "measurement_design",
    "product",
    "delivery_install",
    "min_order_adjustment",
  ]);
});

test("order minimum still tops up a small, close job to $250", () => {
  // measurement 37.50 + foam 49.80 + shipping 18.73 = 106.03 → +143.97 → 250.00
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  const adj = line(q, "min_order_adjustment");
  assert.equal(adj.amount_cents, 25000 - (MEASURE_30 + 4980 + SHIP_LEGACY_1));
  assert.equal(q.total_cents, 25000);
});

test("no order-minimum line once services + foam clear $250", () => {
  const q = computeQuote([legacyDrawer("d1", 4)], { ...INPUTS, round_trip_miles: 100 }, cfg);
  // measurement 125.00, foam 4×49.80=199.20, shipping 15+round(9.9592×1.50)=29.94 → 354.14
  assert.equal(q.lines.some((l) => l.kind === "min_order_adjustment"), false);
  assert.equal(q.total_cents, 12500 + 4980 * 4 + 2994);
  assert.equal(q.total_cents, q.lines.reduce((s, l) => s + l.amount_cents, 0)); // reconciles
});

// ---- internal cost + margin (recovery) -------------------------------------
test("far job: v4 keeps positive margin (1 trip), still flagged under 60%", () => {
  const big: QuoteDrawerInput = {
    id: "big",
    nickname: "big",
    dimensions: { length: 25.5, width: 49, thickness: 0.5, units: "in" }, // 8.677 sqft → $173.54
  };
  const q = computeQuote([big], { round_trip_miles: 120, drive_hours_per_trip: 2, install_hours: 1 }, cfg);
  // sell: measurement 120×1.25=150, foam 173.54, shipping 15+round(8.6771×1.50)=28.02 = 351.56
  assert.equal(q.total_cents, 15000 + 17354 + 2802);
  // internal cost (1 trip default): mileage 120×0.70=84, driving 2×20=40, scanning ≈14.46, install 20 → 158.46
  assert.equal(q.cost_breakdown.assumptions.trips, 1);
  assert.ok(q.gross_profit_cents > 0);
  assert.ok(q.gross_margin! > 0.45 && q.gross_margin! < 0.6);
  assert.equal(q.below_target, true); // flagged, never repriced
});

test("mileage sanity guard warns on absurd distance (not blocked)", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 400 }, cfg);
  assert.ok(q.warnings.some((w) => w.includes("unusually high")));
  assert.equal(line(q, "measurement_design").amount_cents, 400 * 125); // still priced
});

test("drive-hours guard catches the impossible-speed typo (20 hr / 40 mi)", () => {
  const bad = computeQuote([legacyDrawer("d1")], { round_trip_miles: 40, drive_hours_per_trip: 20, install_hours: 1 }, cfg);
  const good = computeQuote([legacyDrawer("d1")], { round_trip_miles: 40, drive_hours_per_trip: 1, install_hours: 1 }, cfg);
  assert.ok(bad.warnings.some((w) => w.includes("mph")));
  // the bad hours tank the internal margin but leave the CUSTOMER total identical:
  assert.equal(bad.total_cents, good.total_cents);
  assert.ok(bad.estimated_cost_cents > good.estimated_cost_cents);
});

test("install-hours guard warns on absurd hours", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, install_hours: 40 }, cfg);
  assert.ok(q.warnings.some((w) => w.includes("install hours")));
});

// ---- product tiers ----------------------------------------------------------
test("tiers price at their own $/sqft: essential $20, professional $24, premium $28", () => {
  const mk = (tier?: string): QuoteDrawerInput => ({
    id: `t-${tier ?? "none"}`,
    nickname: tier ?? "untagged",
    dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" }, // exactly 4 sqft
    tier,
  });
  const q = computeQuote([mk("essential"), mk("professional"), mk("premium"), mk(undefined)], INPUTS, cfg);
  const products = q.lines.filter((l) => l.kind === "product");
  assert.deepEqual(
    products.map((p) => p.unit_price_cents),
    [4 * 2000, 4 * 2400, 4 * 2800, 4 * 2000], // untagged prices as essential
  );
  assert.deepEqual(
    products.map((p) => p.meta.tier),
    ["essential", "professional", "premium", "essential"],
  );
  assert.match(products[1].description, /\(Professional\)/);
  assert.equal(products[1].meta.sqft_rate_cents, 2400);
});

test("unknown tier warns and prices as essential", () => {
  const q = computeQuote(
    [{ id: "x", nickname: "weird", dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" }, tier: "deluxe" }],
    INPUTS,
    cfg,
  );
  assert.equal(line(q, "product").unit_price_cents, 4 * 2000);
  assert.ok(q.warnings.some((w) => w.includes('unknown tier "deluxe"')));
});

test("v2 config (no tier_rates): non-essential tier falls back to base rate WITH warning", () => {
  const v2: PricingConfig = JSON.parse(JSON.stringify(cfg));
  delete v2.product.tier_rates_cents_per_sqft;
  const q = computeQuote(
    [{ id: "p", nickname: "pro", dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" }, tier: "professional" }],
    INPUTS,
    parsePricingConfig(JSON.parse(JSON.stringify(v2))),
  );
  assert.equal(line(q, "product").unit_price_cents, 4 * 2000); // base rate, not silent $24
  assert.ok(q.warnings.some((w) => w.includes("no Professional rate")));
});

test("tier rate composes with thickness multiplier; $40 floor applies per copy across tiers", () => {
  const thick: PricingConfig = parsePricingConfig(
    JSON.parse(JSON.stringify({ ...cfg, product: { ...cfg.product, thickness_multipliers: { "0.5": 1.0, "1": 1.5 } } })),
  );
  const p = line(
    computeQuote(
      [{ id: "x", nickname: "1in-pro", dimensions: { width: 24, length: 24, thickness: 1, units: "in" }, tier: "professional" }],
      INPUTS,
      thick,
    ),
    "product",
  );
  assert.equal(p.unit_price_cents, Math.round(4 * 2400 * 1.5)); // 4 sqft × $36/sqft
  // tiny premium drawer prices purely by sqft (no floor since v4):
  const tiny = line(
    computeQuote(
      [{ id: "t", nickname: "tiny", dimensions: { width: 6, length: 6, thickness: 0.5, units: "in" }, tier: "premium", copies: 2 }],
      INPUTS,
      cfg,
    ),
    "product",
  );
  assert.equal(tiny.unit_price_cents, 700); // 0.25 sqft × $28
  assert.equal(tiny.amount_cents, 1400);
});

// ---- config-driven bits -----------------------------------------------------
test("thickness multiplier scales per-copy foam and its sqft rate", () => {
  const thick: PricingConfig = parsePricingConfig(
    JSON.parse(JSON.stringify({ ...cfg, product: { ...cfg.product, thickness_multipliers: { "0.5": 1.0, "1": 1.5 } } })),
  );
  const p = line(
    computeQuote([{ id: "x", nickname: "1in", dimensions: { width: 24, length: 24, thickness: 1, units: "in" } }], INPUTS, thick),
    "product",
  );
  assert.equal(p.unit_price_cents, Math.round(4 * 2000 * 1.5)); // 4 sqft × $30/sqft = $120
  assert.equal(p.meta.sqft_rate_cents, 3000);
});

test("upgrades price per PHYSICAL drawer", () => {
  const withUpgrades: PricingConfig = {
    ...cfg,
    upgrades: { engraving: { label: "Laser engraving", kind: "per_drawer", price_cents: 1500 } },
  };
  const q = computeQuote([legacyDrawer("a", 2), legacyDrawer("b", 1)], { ...INPUTS, upgrade_keys: ["engraving"] }, withUpgrades);
  assert.equal(line(q, "upgrade").amount_cents, 1500 * 3); // 2 + 1 physical drawers
});

test("unreadable drawers reported, priced drawers still produce lines", () => {
  const q = computeQuote([legacyDrawer("ok"), { id: "bad", nickname: "bad", dimensions: null }], INPUTS, cfg);
  assert.equal(q.unpriced_drawers.length, 1);
  assert.equal(q.lines.filter((l) => l.kind === "product").length, 1);
});

test("empty drawer list: no product + no min-adjustment (service lines still emit)", () => {
  const q = computeQuote([], INPUTS, cfg);
  assert.equal(q.lines.some((l) => l.kind === "product"), false);
  assert.equal(q.lines.some((l) => l.kind === "min_order_adjustment"), false);
  assert.equal(q.total_cents, MEASURE_30 + SHIP_EMPTY);
});

test("determinism: same inputs → identical quote", () => {
  const a = computeQuote([scannedDrawer, legacyDrawer("d1", 2)], INPUTS, cfg);
  const b = computeQuote([scannedDrawer, legacyDrawer("d1", 2)], INPUTS, cfg);
  assert.deepEqual(a, b);
});

test("total always equals the exact line sum (to the cent)", () => {
  for (const miles of [0, 15, 30, 100, 250]) {
    const q = computeQuote([legacyDrawer("a", 2), legacyDrawer("b", 1)], { ...INPUTS, round_trip_miles: miles }, cfg);
    assert.equal(q.total_cents, q.lines.reduce((s, l) => s + l.amount_cents, 0));
    assert.equal(q.total_cents, q.subtotal_cents);
  }
});

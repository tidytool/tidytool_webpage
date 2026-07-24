/**
 * Quoting-engine unit tests (Stage 2: boxes/copies + travel-priced services).
 *
 * Run:  npm run test:pricing
 *
 * Dimension fixtures mirror REAL production `drawer.dimensions` shapes.
 * Pricing model under test: $20/sqft foam per PHYSICAL copy ($40 floor per copy);
 * On-site Measurement & Design = $100 base + round-trip miles × $1.25 (once);
 * Delivery = round-trip miles × $1.25; travel billed on BOTH lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeQuote, type QuoteDrawerInput, type QuoteInputs } from "./engine";
import { DEFAULT_PRICING_CONFIG, parsePricingConfig, type PricingConfig } from "./config";
import { isNormalizeFailure, normalizeDrawerDimensions } from "./normalize";

const cfg = DEFAULT_PRICING_CONFIG;

// miles 30 → measurement travel 30×125=3750; measurement line = 10000+3750 = 13750; delivery = 3750
const INPUTS: QuoteInputs = { round_trip_miles: 30, drive_hours_per_trip: 0.75, install_hours: 1 };
const MEASURE_30 = 13750;
const DELIVER_30 = 3750;

const legacyDrawer = (id: string, copies?: number): QuoteDrawerInput => ({
  id,
  nickname: `legacy-${id}`,
  dimensions: { length: 19.25, width: 18.625, thickness: 0.5, units: "in" },
  ...(copies != null ? { copies } : {}),
}); // area 2.4898 sqft → per-copy $49.80

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

// ---- service lines are now priced (base + travel) --------------------------
test("services are travel-priced, not Included", () => {
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  const m = line(q, "measurement_design");
  const d = line(q, "delivery_install");
  assert.equal(m.amount_cents, MEASURE_30); // 100 + 30×1.25 = 137.50
  assert.equal(m.included, false);
  assert.equal(d.amount_cents, DELIVER_30); // 30×1.25 = 37.50
  assert.equal(d.included, false);
});

test("travel is billed on BOTH visits at $1.25/mi", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 80 }, cfg);
  assert.equal(line(q, "measurement_design").meta.travel_cents, 80 * 125);
  assert.equal(line(q, "delivery_install").meta.travel_cents, 80 * 125);
  assert.equal(line(q, "measurement_design").meta.base_cents, 10000);
});

test("zero miles → measurement is just the $100 base, delivery is $0", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 0 }, cfg);
  assert.equal(line(q, "measurement_design").amount_cents, 10000);
  assert.equal(line(q, "delivery_install").amount_cents, 0);
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

test("per-drawer $40 minimum floors EACH copy", () => {
  const small: QuoteDrawerInput = {
    id: "s",
    nickname: "small",
    dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" }, // 1 sqft → $20 → floored $40
    copies: 2,
  };
  const p = line(computeQuote([small], INPUTS, cfg), "product");
  assert.equal(p.unit_price_cents, 4000); // per-copy floored
  assert.equal(p.amount_cents, 8000); // × 2 copies
  assert.equal(p.meta.drawer_minimum_applied, true);
  assert.equal(p.meta.per_copy_before_minimum_cents, 2000);
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
  // measurement 137.50 + foam 49.80 + delivery 37.50 = 224.80 → +25.20 → 250.00
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  const adj = line(q, "min_order_adjustment");
  assert.equal(adj.amount_cents, 25000 - 22480);
  assert.equal(q.total_cents, 25000);
});

test("no order-minimum line once services + foam clear $250", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 100 }, cfg);
  // measurement 100+125=225.00, foam 49.80, delivery 125.00 → 399.80
  assert.equal(q.lines.some((l) => l.kind === "min_order_adjustment"), false);
  assert.equal(q.total_cents, 22500 + 4980 + 12500);
  assert.equal(q.total_cents, q.lines.reduce((s, l) => s + l.amount_cents, 0)); // reconciles
});

// ---- internal cost + margin (recovery) -------------------------------------
test("far job that was negative now recovers (positive margin, still flagged)", () => {
  const big: QuoteDrawerInput = {
    id: "big",
    nickname: "big",
    dimensions: { length: 25.5, width: 49, thickness: 0.5, units: "in" }, // 8.677 sqft → $173.54
  };
  const q = computeQuote([big], { round_trip_miles: 120, drive_hours_per_trip: 2, install_hours: 1 }, cfg);
  // sell: measurement 100+150=250, foam 173.54, delivery 150 = 573.54
  assert.equal(q.total_cents, 25000 + 17354 + 15000);
  // internal cost: mileage 120×2×0.70=168, driving 2×2×20=80, scanning 8.677×5/60×20≈14.46, install 20
  assert.ok(q.gross_profit_cents > 0); // was NEGATIVE before Stage 2
  assert.ok(q.gross_margin! > 0.45 && q.gross_margin! < 0.6);
  assert.equal(q.below_target, true); // still under 60% on a far, small-foam job — flagged, not repriced
});

test("mileage sanity guard warns on absurd distance (not blocked)", () => {
  const q = computeQuote([legacyDrawer("d1")], { ...INPUTS, round_trip_miles: 400 }, cfg);
  assert.ok(q.warnings.some((w) => w.includes("unusually high")));
  assert.equal(line(q, "measurement_design").amount_cents, 10000 + 400 * 125); // still priced
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
  assert.equal(q.total_cents, MEASURE_30 + DELIVER_30);
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

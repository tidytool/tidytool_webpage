/**
 * Quoting-engine unit tests. Pure logic, no Supabase, no Next.
 *
 * Run:  npm run test:pricing        (uses npx tsx --test; no dependency added)
 *
 * The dimension fixtures mirror REAL production `drawer.dimensions` shapes
 * (legacy inches, feetDecimal scans, mm, thickness-as-object) — if tidyCAM
 * grows a new shape, add it here first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeQuote, type QuoteDrawerInput, type QuoteInputs } from "./engine";
import { DEFAULT_PRICING_CONFIG, parsePricingConfig, type PricingConfig } from "./config";
import { isNormalizeFailure, normalizeDrawerDimensions } from "./normalize";

const cfg = DEFAULT_PRICING_CONFIG;

const INPUTS: QuoteInputs = {
  round_trip_miles: 30,
  drive_hours_per_trip: 0.75,
  install_hours: 1,
};

const legacyDrawer = (id: string, length = 19.25, width = 18.625): QuoteDrawerInput => ({
  id,
  nickname: `legacy-${id}`,
  dimensions: { length, width, thickness: 0.5, units: "in" },
});

// Real prod scan row (drawer bbf1bcc3…): decimal feet + enum thickness.
const scannedDrawer: QuoteDrawerInput = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  nickname: "scanned",
  dimensions: {
    unit: "feetDecimal",
    width: 1.217191601049869,
    height: 1.6699475065616798,
    thickness: "oneHalf",
    original_unit: "inches",
    top_color: "black",
    base_color: "red",
  },
};

test("normalizer: legacy inches shape", () => {
  const r = normalizeDrawerDimensions({ length: 19.25, width: 18.625, thickness: 0.5, units: "in" });
  assert.ok(!isNormalizeFailure(r));
  assert.equal(r.width_in, 18.625);
  assert.equal(r.length_in, 19.25);
  assert.equal(r.thickness_in, 0.5);
  assert.equal(r.area_sqft, Math.round(((18.625 * 19.25) / 144) * 10000) / 10000);
});

test("normalizer: feetDecimal scan shape (unit ?? units, height ?? length)", () => {
  const r = normalizeDrawerDimensions(scannedDrawer.dimensions);
  assert.ok(!isNormalizeFailure(r));
  assert.ok(Math.abs(r.width_in - 14.6063) < 0.001);
  assert.ok(Math.abs(r.length_in - 20.0394) < 0.001);
  assert.equal(r.thickness_in, 0.5); // "oneHalf" enum → inches
});

test("normalizer: mm units and thickness-as-object (both live in prod)", () => {
  const mm = normalizeDrawerDimensions({ width: 473, length: 489, units: "mm" });
  assert.ok(!isNormalizeFailure(mm));
  assert.ok(Math.abs(mm.width_in - 18.622) < 0.01);
  assert.equal(mm.thickness_in, null); // missing → engine substitutes default

  const obj = normalizeDrawerDimensions({
    width: 20,
    length: 20,
    units: "in",
    thickness: { label: '3/4"', value: 0.75, unit: "in" },
  });
  assert.ok(!isNormalizeFailure(obj));
  assert.equal(obj.thickness_in, 0.75);
});

test("normalizer: garbage is rejected, not priced at zero", () => {
  assert.ok(isNormalizeFailure(normalizeDrawerDimensions(null)));
  assert.ok(isNormalizeFailure(normalizeDrawerDimensions({ width: 0, length: 10, units: "in" })));
  assert.ok(isNormalizeFailure(normalizeDrawerDimensions({ width: 5, length: 5, units: "furlongs" })));
  // 19"×18" drawer recorded as feet would be 228"×216" — implausible, flagged.
  assert.ok(isNormalizeFailure(normalizeDrawerDimensions({ width: 19, length: 18, units: "ft" })));
});

test("product line: $20/sqft at multiplier 1.0, cent rounding", () => {
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  const product = q.lines.find((l) => l.kind === "product")!;
  // 19.25 × 18.625 = 358.53125 in² = 2.4898 sqft → ×2000¢ = 4979.6 → 4980¢
  assert.equal(product.amount_cents, 4980);
  assert.equal(product.unit_price_cents, 2000);
  assert.equal(product.meta.drawer_minimum_applied, false);
});

test("per-drawer minimum: small drawer floors at $40", () => {
  const small: QuoteDrawerInput = {
    id: "d-small",
    nickname: "small",
    dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" }, // 1 sqft → $20
  };
  const q = computeQuote([small], INPUTS, cfg);
  const product = q.lines.find((l) => l.kind === "product")!;
  assert.equal(product.amount_cents, 4000);
  assert.equal(product.meta.drawer_minimum_applied, true);
  assert.equal(product.meta.amount_before_minimum_cents, 2000);
});

test("order minimum: shortfall ships as a visible adjustment line, total = $250", () => {
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg); // one drawer ≈ $49.80
  const adj = q.lines.find((l) => l.kind === "min_order_adjustment")!;
  assert.equal(adj.amount_cents, 25000 - 4980);
  assert.equal(q.subtotal_cents, 25000);
  assert.equal(q.total_cents, 25000);
});

test("order minimum absent when subtotal clears $250", () => {
  const drawers = Array.from({ length: 6 }, (_, i) => legacyDrawer(`d${i}`)); // 6 × 4980 = 29880
  const q = computeQuote(drawers, INPUTS, cfg);
  assert.equal(q.lines.some((l) => l.kind === "min_order_adjustment"), false);
  assert.equal(q.subtotal_cents, 29880);
  assert.equal(q.total_cents, 29880); // total is the exact line sum, to the cent
});

test("total equals the exact line sum (no whole-dollar rounding)", () => {
  const q = computeQuote(
    [legacyDrawer("a"), legacyDrawer("b"), legacyDrawer("c"), legacyDrawer("d"), legacyDrawer("e"), legacyDrawer("f")],
    INPUTS,
    cfg,
  );
  const lineSum = q.lines.reduce((s, l) => s + l.amount_cents, 0);
  assert.equal(q.total_cents, lineSum);
  assert.equal(q.total_cents, q.subtotal_cents);
  assert.notEqual(q.total_cents % 100, 0); // 6 × 4980 = 29880 → a non-round-dollar total survives
});

test("line order and included service lines", () => {
  const q = computeQuote([legacyDrawer("d1")], INPUTS, cfg);
  const kinds = q.lines.map((l) => l.kind);
  assert.deepEqual(kinds, [
    "measurement_design",
    "product",
    "delivery_install",
    "min_order_adjustment",
  ]);
  const measure = q.lines[0];
  const install = q.lines[2];
  assert.equal(measure.amount_cents, 0);
  assert.equal(measure.included, true);
  assert.equal(install.amount_cents, 0);
  assert.equal(install.included, true);
});

test("internal cost model: mileage + driving + scanning + install; margin flagging", () => {
  const big: QuoteDrawerInput = {
    id: "d-big",
    nickname: "big",
    dimensions: { length: 25.5, width: 49, thickness: 0.5, units: "in" }, // real prod dims, 8.6771 sqft
  };
  const q = computeQuote([big], INPUTS, cfg);
  const b = q.cost_breakdown;
  assert.equal(b.assumptions.trips, 2); // default: measure + install
  assert.equal(b.mileage_cents, 30 * 2 * 70); // 4200
  assert.equal(b.driving_labor_cents, Math.round(0.75 * 2 * 2000)); // 3000
  // scanning: 8.6771 sqft × 5 min = 43.39 min = 0.7231 h × $20 = $14.46
  assert.equal(b.scanning_labor_cents, Math.round(((8.6771 * 5) / 60) * 2000));
  assert.equal(b.install_labor_cents, 2000);
  assert.equal(q.estimated_cost_cents, b.mileage_cents + b.driving_labor_cents + b.scanning_labor_cents + b.install_labor_cents);

  // sell: 8.6771 × $20 = $173.54 → order min binds → $250 even
  assert.equal(q.total_cents, 25000);
  assert.equal(q.gross_profit_cents, q.total_cents - q.estimated_cost_cents);
  assert.equal(q.gross_margin, Math.round((q.gross_profit_cents / q.total_cents) * 10000) / 10000);
  // $250 sell against ~$106 cost ≈ 57.4% margin → below the 60% target → flagged
  assert.equal(q.below_target, true);
  assert.equal(q.margin_target, 0.6);
});

test("healthy job clears the margin target", () => {
  const drawers = Array.from({ length: 10 }, (_, i) => legacyDrawer(`d${i}`)); // $498 product
  const q = computeQuote(drawers, { ...INPUTS, round_trip_miles: 10, drive_hours_per_trip: 0.25 }, cfg);
  assert.equal(q.below_target, false);
  assert.ok(q.gross_margin! >= 0.6);
});

test("thickness multipliers are config-driven", () => {
  const thick: PricingConfig = parsePricingConfig(
    JSON.parse(JSON.stringify({ ...cfg, product: { ...cfg.product, thickness_multipliers: { "0.5": 1.0, "1": 1.5 } } })),
  );
  const oneInch: QuoteDrawerInput = {
    id: "d-1in",
    nickname: "one-inch",
    dimensions: { width: 24, length: 24, thickness: 1, units: "in" }, // 4 sqft
  };
  const q = computeQuote([oneInch], INPUTS, thick);
  const product = q.lines.find((l) => l.kind === "product")!;
  assert.equal(product.amount_cents, Math.round(4 * 2000 * 1.5)); // 12000
  assert.equal(q.warnings.length, 0);
});

test("unknown thickness falls back to default multiplier with a warning", () => {
  const q = computeQuote(
    [{ id: "d-x", nickname: "x", dimensions: { width: 24, length: 24, thickness: 2, units: "in" } }],
    INPUTS,
    cfg,
  );
  const product = q.lines.find((l) => l.kind === "product")!;
  assert.equal(product.amount_cents, 8000); // default ×1.0
  assert.ok(q.warnings.some((w) => w.includes('no multiplier for 2"')));
});

test("missing thickness assumes the standard 0.5\" with a warning", () => {
  const q = computeQuote(
    [{ id: "d-y", nickname: "y", dimensions: { width: 24, length: 24, units: "in" } }],
    INPUTS,
    cfg,
  );
  const product = q.lines.find((l) => l.kind === "product")!;
  assert.equal(product.meta.thickness_in, 0.5);
  assert.ok(q.warnings.some((w) => w.includes("assumed standard")));
});

test("unreadable drawers are reported, never silently skipped from the math", () => {
  const q = computeQuote([legacyDrawer("ok"), { id: "bad", nickname: "bad", dimensions: null }], INPUTS, cfg);
  assert.equal(q.unpriced_drawers.length, 1);
  assert.equal(q.unpriced_drawers[0].id, "bad");
  assert.equal(q.lines.filter((l) => l.kind === "product").length, 1);
});

test("upgrades: config entries price by kind; unknown keys warn", () => {
  const withUpgrades: PricingConfig = {
    ...cfg,
    upgrades: {
      engraving: { label: "Laser engraving", kind: "per_drawer", price_cents: 1500 },
      rush: { label: "Rush turnaround", kind: "flat", price_cents: 5000 },
    },
  };
  const q = computeQuote(
    [legacyDrawer("d1"), legacyDrawer("d2")],
    { ...INPUTS, upgrade_keys: ["engraving", "rush", "nope"] },
    withUpgrades,
  );
  const ups = q.lines.filter((l) => l.kind === "upgrade");
  assert.equal(ups.length, 2);
  assert.equal(ups[0].amount_cents, 3000); // 2 drawers × $15
  assert.equal(ups[1].amount_cents, 5000);
  assert.ok(q.warnings.some((w) => w.includes('unknown upgrade "nope"')));
});

test("empty drawer list: no product lines, no order-minimum adjustment", () => {
  const q = computeQuote([], INPUTS, cfg);
  assert.equal(q.lines.some((l) => l.kind === "product"), false);
  assert.equal(q.lines.some((l) => l.kind === "min_order_adjustment"), false);
  assert.equal(q.subtotal_cents, 0);
  assert.equal(q.total_cents, 0);
  assert.equal(q.gross_margin, null);
  assert.equal(q.below_target, false);
});

test("determinism: same inputs → identical quote", () => {
  const a = computeQuote([scannedDrawer, legacyDrawer("d1")], INPUTS, cfg);
  const b = computeQuote([scannedDrawer, legacyDrawer("d1")], INPUTS, cfg);
  assert.deepEqual(a, b);
});

/**
 * Quoting engine — pure, deterministic, config-driven.
 *
 * computeQuote(drawers, inputs, config) → line items + totals + internal cost
 * estimate + margin flags. No I/O, no Date.now(), no randomness: the same
 * inputs always produce the same quote, which is what makes stored quotes
 * auditable against the config row they reference.
 *
 * Money is INTEGER CENTS throughout (matching order.total_price). Line items
 * round to the nearest cent (at the multiply step); the total is the exact sum
 * of the lines, so the customer's line column always reconciles to the total.
 *
 * Customer-facing lines, in presentation order:
 *   1. On-site Measurement & Design          (included, $0)
 *   2. Custom Foam Tool Organizer(s)         (one line per drawer)
 *   3. Optional Upgrades                     (only when upgrades are selected)
 *   4. Delivery, Installation & Test Fit     (included, $0)
 *   5. Minimum Order Adjustment              (only when the order minimum binds)
 *
 * The internal cost model (mileage, driving/scanning/install labor) is
 * computed alongside but stored separately — it must never render on a
 * customer-facing surface.
 */

import { type PricingConfig } from "./config";
import {
  isNormalizeFailure,
  normalizeDrawerDimensions,
  type NormalizedDrawerDims,
} from "./normalize";

export type QuoteLineKind =
  | "measurement_design"
  | "product"
  | "upgrade"
  | "delivery_install"
  | "min_order_adjustment";

export type QuoteLine = {
  position: number;
  kind: QuoteLineKind;
  description: string;
  drawer_id: string | null;
  /** Quantity in `unit` (sqft for product lines). Null for flat lines. */
  qty: number | null;
  unit: string | null;
  /** Rate per unit in cents, when qty-based. */
  unit_price_cents: number | null;
  amount_cents: number;
  /** True renders as "Included" instead of $0.00. */
  included: boolean;
  /** Machine-readable detail (normalized dims, minimum applied, …). */
  meta: Record<string, unknown>;
};

export type QuoteCostBreakdown = {
  mileage_cents: number;
  driving_labor_cents: number;
  scanning_labor_cents: number;
  install_labor_cents: number;
  total_cents: number;
  assumptions: {
    trips: number;
    round_trip_miles: number;
    drive_hours_per_trip: number;
    install_hours: number;
    scanning_hours: number;
    total_area_sqft: number;
  };
};

export type QuoteDrawerInput = {
  id: string;
  nickname: string | null;
  dimensions: unknown;
};

export type QuoteInputs = {
  /** Round-trip distance to the customer, in miles (one visit's round trip). */
  round_trip_miles: number;
  /** Driving time for one round trip, in hours. */
  drive_hours_per_trip: number;
  /** Estimated on-site installation labor, in hours. */
  install_hours: number;
  /** Round trips for the job. Defaults to config costs.default_trips (2: measure + install). */
  trips?: number;
  /** Keys into config.upgrades selected for this quote. Unknown keys are reported, not priced. */
  upgrade_keys?: string[];
};

export type ComputedQuote = {
  lines: QuoteLine[];
  /** Sum of customer-facing lines (incl. minimum adjustment), exact cents. */
  subtotal_cents: number;
  /** Exact sum of the lines — equals subtotal_cents (total is to the cent). */
  total_cents: number;
  estimated_cost_cents: number;
  cost_breakdown: QuoteCostBreakdown;
  gross_profit_cents: number;
  /** (total − cost) / total, 4 dp. Null when total is 0. */
  gross_margin: number | null;
  margin_target: number;
  /** True = below target margin. Flag for review — never auto-repriced. */
  below_target: boolean;
  /** Non-fatal assumptions made while pricing (missing thickness, etc.). */
  warnings: string[];
  /** Drawers that could NOT be priced (unreadable dimensions). Non-empty ⇒ quote is incomplete. */
  unpriced_drawers: { id: string; nickname: string | null; reason: string }[];
};

const roundCents = (n: number): number => Math.round(n);

function thicknessMultiplier(
  thickness_in: number,
  config: PricingConfig,
  warnings: string[],
  drawerLabel: string,
): number {
  // Keys are stringified inches; tolerate "0.50" vs "0.5" by numeric compare.
  for (const [key, mult] of Object.entries(config.product.thickness_multipliers)) {
    if (Number(key) === thickness_in) return mult;
  }
  warnings.push(
    `${drawerLabel}: no multiplier for ${thickness_in}" thickness — used default ×${config.product.default_thickness_multiplier}`,
  );
  return config.product.default_thickness_multiplier;
}

function fmtIn(n: number): string {
  return `${Math.round(n * 100) / 100}"`;
}

export function computeQuote(
  drawers: QuoteDrawerInput[],
  inputs: QuoteInputs,
  config: PricingConfig,
): ComputedQuote {
  const warnings: string[] = [];
  const unpriced: ComputedQuote["unpriced_drawers"] = [];
  const lines: QuoteLine[] = [];
  let position = 0;

  // ---- 1. On-site Measurement & Design ------------------------------------
  const svcMeasure = config.services.measurement_design;
  lines.push({
    position: ++position,
    kind: "measurement_design",
    description: svcMeasure.label,
    drawer_id: null,
    qty: null,
    unit: null,
    unit_price_cents: null,
    amount_cents: svcMeasure.included ? 0 : roundCents(svcMeasure.price_cents),
    included: svcMeasure.included,
    meta: {},
  });

  // ---- 2. Product lines: one per drawer -----------------------------------
  let totalAreaSqft = 0;
  const priced: { drawer: QuoteDrawerInput; dims: NormalizedDrawerDims }[] = [];
  for (const drawer of drawers) {
    const result = normalizeDrawerDimensions(drawer.dimensions);
    if (isNormalizeFailure(result)) {
      unpriced.push({ id: drawer.id, nickname: drawer.nickname, reason: result.error });
      continue;
    }
    priced.push({ drawer, dims: result });
  }

  for (const { drawer, dims } of priced) {
    const label = drawer.nickname || `Drawer ${drawer.id.slice(0, 8)}`;
    for (const w of dims.warnings) warnings.push(`${label}: ${w}`);

    let thickness = dims.thickness_in;
    if (thickness == null) {
      thickness = config.product.default_thickness_in;
      warnings.push(`${label}: no readable thickness — assumed standard ${fmtIn(thickness)}`);
    }
    const mult = thicknessMultiplier(thickness, config, warnings, label);

    const rawCents = dims.area_sqft * config.product.rate_cents_per_sqft * mult;
    const beforeMin = roundCents(rawCents);
    const amount = Math.max(beforeMin, config.minimums.per_drawer_cents);
    const minApplied = amount > beforeMin;

    totalAreaSqft += dims.area_sqft;
    lines.push({
      position: ++position,
      kind: "product",
      description:
        `Custom Foam Tool Organizer — ${label} ` +
        `(${fmtIn(dims.width_in)} × ${fmtIn(dims.length_in)}, ${fmtIn(thickness)} foam)`,
      drawer_id: drawer.id,
      qty: dims.area_sqft,
      unit: "sqft",
      unit_price_cents: roundCents(config.product.rate_cents_per_sqft * mult),
      amount_cents: amount,
      included: false,
      meta: {
        width_in: dims.width_in,
        length_in: dims.length_in,
        thickness_in: thickness,
        area_sqft: dims.area_sqft,
        thickness_multiplier: mult,
        drawer_minimum_applied: minApplied,
        ...(minApplied ? { amount_before_minimum_cents: beforeMin } : {}),
      },
    });
  }

  // ---- 3. Optional Upgrades (config-driven; none defined yet) -------------
  const drawerCount = priced.length;
  for (const key of inputs.upgrade_keys ?? []) {
    const upgrade = config.upgrades[key];
    if (!upgrade) {
      warnings.push(`unknown upgrade "${key}" — skipped`);
      continue;
    }
    const qty =
      upgrade.kind === "per_drawer" ? drawerCount : upgrade.kind === "per_sqft" ? totalAreaSqft : 1;
    lines.push({
      position: ++position,
      kind: "upgrade",
      description: `Optional Upgrade — ${upgrade.label}`,
      drawer_id: null,
      qty,
      unit: upgrade.kind === "per_sqft" ? "sqft" : upgrade.kind === "per_drawer" ? "drawer" : null,
      unit_price_cents: upgrade.price_cents,
      amount_cents: roundCents(qty * upgrade.price_cents),
      included: false,
      meta: { upgrade_key: key },
    });
  }

  // ---- 4. Delivery, Installation & Test Fit -------------------------------
  const svcInstall = config.services.delivery_install;
  lines.push({
    position: ++position,
    kind: "delivery_install",
    description: svcInstall.label,
    drawer_id: null,
    qty: null,
    unit: null,
    unit_price_cents: null,
    amount_cents: svcInstall.included ? 0 : roundCents(svcInstall.price_cents),
    included: svcInstall.included,
    meta: {},
  });

  // ---- 5. Minimum Order Adjustment ----------------------------------------
  let subtotal = lines.reduce((sum, l) => sum + l.amount_cents, 0);
  if (drawerCount > 0 && subtotal < config.minimums.per_order_cents) {
    const shortfall = config.minimums.per_order_cents - subtotal;
    lines.push({
      position: ++position,
      kind: "min_order_adjustment",
      description: "Minimum Order Adjustment",
      drawer_id: null,
      qty: null,
      unit: null,
      unit_price_cents: null,
      amount_cents: shortfall,
      included: false,
      meta: {
        order_minimum_cents: config.minimums.per_order_cents,
        subtotal_before_adjustment_cents: subtotal,
      },
    });
    subtotal += shortfall;
  }

  // Total is the exact line sum (to the cent) — no whole-dollar rounding, so
  // the customer's line column always adds up to the total.
  const total = subtotal;

  // ---- Internal cost model (never customer-facing) ------------------------
  const trips = inputs.trips ?? config.costs.default_trips;
  const scanningHours = (totalAreaSqft * config.costs.scanning_minutes_per_sqft) / 60;
  const mileage = roundCents(inputs.round_trip_miles * trips * config.costs.mileage_cents_per_round_trip_mile);
  const drivingLabor = roundCents(inputs.drive_hours_per_trip * trips * config.costs.driving_labor_cents_per_hour);
  const scanningLabor = roundCents(scanningHours * config.costs.scanning_labor_cents_per_hour);
  const installLabor = roundCents(inputs.install_hours * config.costs.install_labor_cents_per_hour);
  const estimatedCost = mileage + drivingLabor + scanningLabor + installLabor;

  const grossProfit = total - estimatedCost;
  const grossMargin = total > 0 ? Math.round((grossProfit / total) * 10000) / 10000 : null;
  const belowTarget = grossMargin != null && grossMargin < config.margin.target;

  return {
    lines,
    subtotal_cents: subtotal,
    total_cents: total,
    estimated_cost_cents: estimatedCost,
    cost_breakdown: {
      mileage_cents: mileage,
      driving_labor_cents: drivingLabor,
      scanning_labor_cents: scanningLabor,
      install_labor_cents: installLabor,
      total_cents: estimatedCost,
      assumptions: {
        trips,
        round_trip_miles: inputs.round_trip_miles,
        drive_hours_per_trip: inputs.drive_hours_per_trip,
        install_hours: inputs.install_hours,
        scanning_hours: Math.round(scanningHours * 100) / 100,
        total_area_sqft: Math.round(totalAreaSqft * 10000) / 10000,
      },
    },
    gross_profit_cents: grossProfit,
    gross_margin: grossMargin,
    margin_target: config.margin.target,
    below_target: belowTarget,
    warnings,
    unpriced_drawers: unpriced,
  };
}

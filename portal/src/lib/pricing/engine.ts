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
 *   1. On-site Measurement & Design          (scan-visit travel; design base if configured)
 *   2. Custom Foam Tool Organizer(s)         (one line per drawer, tier-priced)
 *   3. Optional Upgrades                     (only when upgrades are selected)
 *   4. Delivery & Installation               (v4+: shipping estimate — base + per-sqft
 *                                             of physical foam; legacy configs: travel)
 *   5. Minimum Order Adjustment              (only when the order minimum binds)
 *
 * The internal cost model (mileage, driving/scanning/install labor) is
 * computed alongside but stored separately — it must never render on a
 * customer-facing surface.
 */

import { TIER_LABEL, isTier, type PricingConfig, type Tier } from "./config";
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
  /** Quantity in `unit` (copies for product lines). Null for flat lines. */
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
  /** Physical copies of this drawer = box.quantity × drawer.quantity. Default 1. */
  copies?: number;
  /**
   * Product tier (essential | professional | premium), set per drawer.
   * Unknown/missing values price as essential with a warning.
   */
  tier?: string | null;
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
const round2 = (n: number): number => Math.round(n * 100) / 100;
const dollars = (cents: number): string => (cents / 100).toFixed(2);

/** Round-trip miles above this are flagged for a typo check (not blocked). */
const MILEAGE_SANITY_THRESHOLD = 300;

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

/**
 * Resolve a drawer's tier and its $/sqft rate. Unknown tiers price as
 * essential (warned). A tiered drawer on a config without tier_rates (v2)
 * falls back to the flat rate — warned for non-essential tiers, since that
 * silently underprices Professional/Premium work.
 */
function tierRate(
  rawTier: string | null | undefined,
  config: PricingConfig,
  warnings: string[],
  drawerLabel: string,
): { tier: Tier; rate_cents: number } {
  let tier: Tier = "essential";
  if (rawTier != null && rawTier !== "") {
    if (isTier(rawTier)) {
      tier = rawTier;
    } else {
      warnings.push(`${drawerLabel}: unknown tier "${rawTier}" — priced as Essential`);
    }
  }
  const rate = config.product.tier_rates_cents_per_sqft?.[tier];
  if (rate != null) return { tier, rate_cents: rate };
  if (tier !== "essential") {
    warnings.push(
      `${drawerLabel}: active pricing config has no ${TIER_LABEL[tier]} rate — used the base rate (update pricing_config to v3)`,
    );
  }
  return { tier, rate_cents: config.product.rate_cents_per_sqft };
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

  // Travel is billed on the SCAN visit at the config per-mile rate (delivery
  // ships since v4); miles < 0 is clamped, absurdly high miles are flagged below.
  const miles = Math.max(0, inputs.round_trip_miles);
  if (miles > MILEAGE_SANITY_THRESHOLD) {
    warnings.push(
      `round-trip miles = ${round2(miles)} — unusually high; confirm it isn't a typo`,
    );
  }
  // Labor-hours sanity: a 20-hour drive for a 40-mile trip is a data-entry typo.
  // These inputs only affect the INTERNAL margin estimate, never the customer
  // price — but a bad value makes the margin flag meaningless, so surface it.
  const dh = inputs.drive_hours_per_trip;
  if (dh >= 1 && miles > 0 && miles / dh < 5) {
    warnings.push(
      `drive hours/trip = ${round2(dh)} for a ${round2(miles)} mi round trip ≈ ${round2(miles / dh)} mph — check the hours (affects the internal margin, not the customer price)`,
    );
  } else if (dh > 12) {
    warnings.push(`drive hours/trip = ${round2(dh)} is unusually high — confirm it isn't a typo`);
  }
  if (inputs.install_hours > 12) {
    warnings.push(`install hours = ${round2(inputs.install_hours)} is unusually high — confirm it isn't a typo`);
  }

  // ---- 1. On-site Measurement & Design (scan-visit travel; base if configured) ----
  // v4 dropped the $100 design base (base_cents = 0) — the line is purely
  // miles × rate. The base still renders for older configs that carry one.
  const svcMeasure = config.services.measurement_design;
  const measureTravel = roundCents(miles * svcMeasure.travel_cents_per_mile);
  const measureParts: string[] = [];
  if (svcMeasure.base_cents > 0) measureParts.push(`$${dollars(svcMeasure.base_cents)} design`);
  if (miles > 0) {
    measureParts.push(`${round2(miles)} mi round-trip @ $${dollars(svcMeasure.travel_cents_per_mile)}/mi`);
  }
  lines.push({
    position: ++position,
    kind: "measurement_design",
    description: measureParts.length > 0 ? `${svcMeasure.label} (${measureParts.join(" + ")})` : svcMeasure.label,
    drawer_id: null,
    qty: null,
    unit: null,
    unit_price_cents: null,
    amount_cents: svcMeasure.base_cents + measureTravel,
    included: false,
    meta: {
      base_cents: svcMeasure.base_cents,
      travel_cents: measureTravel,
      round_trip_miles: miles,
    },
  });

  // ---- 2. Product lines: one per drawer DESIGN, priced × physical copies ---
  // Foam ($20/sqft, $40 floor) is per PHYSICAL drawer, so it scales with copies
  // (box.quantity × drawer.quantity). The $40 minimum floors each copy, not the
  // line. Scanning/design is charged ONCE (the measurement line), not per copy —
  // so totalAreaSqft (which drives internal scanning cost) is DESIGN area only.
  let totalAreaSqft = 0;
  let totalPhysicalAreaSqft = 0; // design sqft × copies — what actually ships
  let totalPhysicalDrawers = 0;
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

    const copies = Math.max(1, Math.floor(drawer.copies ?? 1));
    const { tier, rate_cents: baseTierRate } = tierRate(drawer.tier, config, warnings, label);

    let thickness = dims.thickness_in;
    if (thickness == null) {
      thickness = config.product.default_thickness_in;
      warnings.push(`${label}: no readable thickness — assumed standard ${fmtIn(thickness)}`);
    }
    const mult = thicknessMultiplier(thickness, config, warnings, label);

    const sqftRate = roundCents(baseTierRate * mult);
    const perCopyRaw = roundCents(dims.area_sqft * baseTierRate * mult);
    const perCopy = Math.max(perCopyRaw, config.minimums.per_drawer_cents);
    const minApplied = perCopy > perCopyRaw;
    const amount = perCopy * copies;

    const dimsText = `${fmtIn(dims.width_in)} × ${fmtIn(dims.length_in)}, ${fmtIn(thickness)} foam`;
    totalAreaSqft += dims.area_sqft;
    totalPhysicalAreaSqft += dims.area_sqft * copies;
    totalPhysicalDrawers += copies;
    lines.push({
      position: ++position,
      kind: "product",
      description:
        `Custom Foam Tool Organizer (${TIER_LABEL[tier]}) — ${label} (${dimsText})` +
        (copies > 1 ? ` × ${copies}` : ""),
      drawer_id: drawer.id,
      qty: copies,
      unit: "copies",
      unit_price_cents: perCopy,
      amount_cents: amount,
      included: false,
      meta: {
        label,
        tier,
        dims_text: dimsText,
        width_in: dims.width_in,
        length_in: dims.length_in,
        thickness_in: thickness,
        area_sqft: dims.area_sqft,
        thickness_multiplier: mult,
        sqft_rate_cents: sqftRate,
        copies,
        per_copy_cents: perCopy,
        drawer_minimum_applied: minApplied,
        ...(minApplied ? { per_copy_before_minimum_cents: perCopyRaw } : {}),
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
      upgrade.kind === "per_drawer" ? totalPhysicalDrawers : upgrade.kind === "per_sqft" ? totalAreaSqft : 1;
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

  // ---- 4. Delivery & Installation ------------------------------------------
  // v4: SHIPPED — expected shipping cost = flat base + per-sqft of the physical
  // foam (design sqft × copies). Legacy configs without shipping fields keep
  // the old travel model (miles × rate) so a new engine on a v2/v3 config
  // still prices the way that config intended.
  const svcInstall = config.services.delivery_install;
  if (svcInstall.shipping_base_cents != null && svcInstall.shipping_cents_per_sqft != null) {
    const shipSqft = round2(totalPhysicalAreaSqft);
    const shipping =
      svcInstall.shipping_base_cents + roundCents(totalPhysicalAreaSqft * svcInstall.shipping_cents_per_sqft);
    lines.push({
      position: ++position,
      kind: "delivery_install",
      description:
        shipSqft > 0
          ? `${svcInstall.label} — estimated shipping (${shipSqft} sqft foam)`
          : `${svcInstall.label} — estimated shipping`,
      drawer_id: null,
      qty: null,
      unit: null,
      unit_price_cents: null,
      amount_cents: shipping,
      included: false,
      meta: {
        shipping_base_cents: svcInstall.shipping_base_cents,
        shipping_cents_per_sqft: svcInstall.shipping_cents_per_sqft,
        physical_area_sqft: shipSqft,
        shipping_cents: shipping,
      },
    });
  } else {
    const deliverTravel = roundCents(miles * svcInstall.travel_cents_per_mile);
    lines.push({
      position: ++position,
      kind: "delivery_install",
      description:
        miles > 0
          ? `${svcInstall.label} (${round2(miles)} mi round-trip @ $${dollars(svcInstall.travel_cents_per_mile)}/mi)`
          : svcInstall.label,
      drawer_id: null,
      qty: null,
      unit: null,
      unit_price_cents: null,
      amount_cents: deliverTravel,
      included: false,
      meta: { travel_cents: deliverTravel, round_trip_miles: miles },
    });
  }

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

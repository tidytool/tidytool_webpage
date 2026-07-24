/**
 * Pricing configuration — the single source of truth for every rate, minimum,
 * multiplier, and cost assumption the quoting engine uses.
 *
 * The engine (engine.ts) is pure and config-driven: adding engraving, rush
 * orders, shipping, discounts, new thickness multipliers, etc. means adding
 * config (and, for new customer-visible charges, an `upgrades` entry) — not
 * editing pricing logic.
 *
 * The live config is stored in the `pricing_config` table (jsonb `config`
 * column, one row with active=true). DEFAULT_PRICING_CONFIG below mirrors the
 * seed row from migration 20260724000000_quoting_engine.sql and doubles as the
 * offline/test fallback. All monetary values are INTEGER CENTS.
 */

export type ThicknessMultipliers = {
  /** Keyed by thickness in inches, stringified (e.g. "0.5", "0.75", "1"). */
  [thicknessIn: string]: number;
};

export type UpgradeConfig = {
  label: string;
  /** 'flat' = price_cents once; 'per_drawer' = price_cents × drawer count; 'per_sqft' = price_cents × total sqft. */
  kind: "flat" | "per_drawer" | "per_sqft";
  price_cents: number;
};

export type PricingConfig = {
  version: number;
  currency: "USD";
  product: {
    /** Customer-facing base rate: cents per square foot of drawer footprint. */
    rate_cents_per_sqft: number;
    /** Multiplier applied to the base rate by foam thickness (inches, stringified key). */
    thickness_multipliers: ThicknessMultipliers;
    /** Assumed when a drawer has no readable thickness (standard = 0.5"). */
    default_thickness_in: number;
    /** Used when a thickness has no entry in thickness_multipliers. */
    default_thickness_multiplier: number;
  };
  minimums: {
    /** Floor for a single drawer's product line. */
    per_drawer_cents: number;
    /** Floor for the whole order; shortfall ships as a visible "Minimum Order Adjustment" line. */
    per_order_cents: number;
  };
  /** Fixed customer-facing service lines. included=true renders as "Included" at $0. */
  services: {
    measurement_design: { label: string; included: boolean; price_cents: number };
    delivery_install: { label: string; included: boolean; price_cents: number };
  };
  /**
   * Optional upgrades (engraving, rush, shipping…). Empty today; entries added
   * here appear under the "Optional Upgrades" line when selected on a quote.
   */
  upgrades: { [key: string]: UpgradeConfig };
  /** INTERNAL cost model — never shown to customers. */
  costs: {
    mileage_cents_per_round_trip_mile: number;
    driving_labor_cents_per_hour: number;
    scanning_labor_cents_per_hour: number;
    install_labor_cents_per_hour: number;
    /** Scanning time estimate: minutes per square foot of drawer area. */
    scanning_minutes_per_sqft: number;
    /** Round trips a standard job assumes (measure + install = 2). */
    default_trips: number;
  };
  margin: {
    /** Target gross margin (0–1). Below-target quotes are flagged, never auto-repriced. */
    target: number;
  };
  rounding: {
    line: "cent";
    /** Total is the exact line sum to the cent ("dollar" retained for future configs). */
    total: "cent" | "dollar";
  };
};

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  version: 1,
  currency: "USD",
  product: {
    rate_cents_per_sqft: 2000, // $20.00 / sqft
    thickness_multipliers: { "0.5": 1.0 },
    default_thickness_in: 0.5,
    default_thickness_multiplier: 1.0,
  },
  minimums: {
    per_drawer_cents: 4000, // $40 / drawer
    per_order_cents: 25000, // $250 / order
  },
  services: {
    measurement_design: {
      label: "On-site Measurement & Design",
      included: true,
      price_cents: 0,
    },
    delivery_install: {
      label: "Delivery, Installation & Test Fit",
      included: true,
      price_cents: 0,
    },
  },
  upgrades: {},
  costs: {
    mileage_cents_per_round_trip_mile: 70, // $0.70 / round-trip mile
    driving_labor_cents_per_hour: 2000, // $20 / hr
    scanning_labor_cents_per_hour: 2000, // $20 / hr
    install_labor_cents_per_hour: 2000, // $20 / hr
    scanning_minutes_per_sqft: 5,
    default_trips: 2, // one measure visit + one install visit
  },
  margin: { target: 0.6 },
  rounding: { line: "cent", total: "cent" },
};

/**
 * Validate an untrusted config blob (e.g. fresh from the DB) well enough to
 * price with it. Returns a typed config or throws with a readable reason.
 */
export function parsePricingConfig(raw: unknown): PricingConfig {
  if (raw == null || typeof raw !== "object") {
    throw new Error("pricing config: not an object");
  }
  const c = raw as PricingConfig;
  const isCents = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (!c.product || !isCents(c.product.rate_cents_per_sqft)) {
    throw new Error("pricing config: product.rate_cents_per_sqft must be integer cents");
  }
  if (!c.minimums || !isCents(c.minimums.per_drawer_cents) || !isCents(c.minimums.per_order_cents)) {
    throw new Error("pricing config: minimums must be integer cents");
  }
  if (!c.costs || !isCents(c.costs.mileage_cents_per_round_trip_mile)) {
    throw new Error("pricing config: costs missing");
  }
  if (!c.margin || typeof c.margin.target !== "number" || c.margin.target <= 0 || c.margin.target >= 1) {
    throw new Error("pricing config: margin.target must be between 0 and 1");
  }
  return c;
}

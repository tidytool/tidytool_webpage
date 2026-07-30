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
 * seed row from the latest pricing migration and doubles as the offline/test
 * fallback. All monetary values are INTEGER CENTS.
 */

/**
 * Product tiers (Sam, 2026-07-30). Set PER DRAWER — orders can mix tiers.
 *   essential    — dual-color cut foam
 *   professional — engraved tool labels
 *   premium      — silk screen + thin protective top layer
 * Each tier has its own $/sqft rate; the $40/copy floor and thickness
 * multipliers apply identically across tiers.
 */
export const TIERS = ["essential", "professional", "premium"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  essential: "Essential",
  professional: "Professional",
  premium: "Premium",
};

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

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
    /**
     * Fallback rate: cents per sqft of drawer footprint. Kept for engines/configs
     * that predate tiers (v2) — with tier_rates present this is only used when a
     * tier has no entry. Equal to the essential rate by convention.
     */
    rate_cents_per_sqft: number;
    /**
     * Per-tier rates, cents per sqft (v3+). Missing map or missing tier key
     * falls back to rate_cents_per_sqft (with an engine warning for
     * non-essential tiers, since that likely means an outdated config).
     */
    tier_rates_cents_per_sqft?: Partial<Record<Tier, number>>;
    /** Multiplier applied to the tier rate by foam thickness (inches, stringified key). */
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
  /**
   * Customer-facing service lines, now travel-priced (Sam, 2026-07-24).
   * $20/sqft already covers on-site labor (scanning + install/test-fit), so these
   * lines are a one-time design base + travel, billed on BOTH visits (scan + delivery).
   * measurement_design line = base_cents + round_trip_miles × travel_cents_per_mile.
   * delivery_install  line  =              round_trip_miles × travel_cents_per_mile.
   */
  services: {
    measurement_design: { label: string; base_cents: number; travel_cents_per_mile: number };
    delivery_install: { label: string; travel_cents_per_mile: number };
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
  version: 3,
  currency: "USD",
  product: {
    // Rates cover foam material + cutting + on-site labor (scanning AND
    // install/test-fit). No separate labor lines — see services below.
    rate_cents_per_sqft: 2000, // fallback = essential rate ($20.00/sqft)
    tier_rates_cents_per_sqft: {
      essential: 2000, // $20.00 / sqft — dual-color cut
      professional: 2400, // $24.00 / sqft — engraved labels
      premium: 2800, // $28.00 / sqft — silk screen + protective top layer
    },
    thickness_multipliers: { "0.5": 1.0 },
    default_thickness_in: 0.5,
    default_thickness_multiplier: 1.0,
  },
  minimums: {
    per_drawer_cents: 4000, // $40 / physical drawer
    per_order_cents: 25000, // $250 / order
  },
  services: {
    measurement_design: {
      label: "On-site Measurement & Design",
      base_cents: 10000, // $100 one-time design/setup, charged once per quote
      travel_cents_per_mile: 125, // $1.25 / round-trip mile (scan visit)
    },
    delivery_install: {
      label: "Delivery, Installation & Test Fit",
      travel_cents_per_mile: 125, // $1.25 / round-trip mile (delivery visit)
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
  if (c.product.tier_rates_cents_per_sqft != null) {
    if (typeof c.product.tier_rates_cents_per_sqft !== "object") {
      throw new Error("pricing config: product.tier_rates_cents_per_sqft must be an object");
    }
    for (const [k, v] of Object.entries(c.product.tier_rates_cents_per_sqft)) {
      if (!isTier(k)) throw new Error(`pricing config: unknown tier "${k}" in tier_rates_cents_per_sqft`);
      if (!isCents(v)) throw new Error(`pricing config: tier rate for "${k}" must be integer cents`);
    }
  }
  if (!c.minimums || !isCents(c.minimums.per_drawer_cents) || !isCents(c.minimums.per_order_cents)) {
    throw new Error("pricing config: minimums must be integer cents");
  }
  const md = c.services?.measurement_design;
  const di = c.services?.delivery_install;
  if (!md || !isCents(md.base_cents) || !isCents(md.travel_cents_per_mile)) {
    throw new Error("pricing config: services.measurement_design needs integer base_cents + travel_cents_per_mile");
  }
  if (!di || !isCents(di.travel_cents_per_mile)) {
    throw new Error("pricing config: services.delivery_install needs integer travel_cents_per_mile");
  }
  if (!c.costs || !isCents(c.costs.mileage_cents_per_round_trip_mile)) {
    throw new Error("pricing config: costs missing");
  }
  if (!c.margin || typeof c.margin.target !== "number" || c.margin.target <= 0 || c.margin.target >= 1) {
    throw new Error("pricing config: margin.target must be between 0 and 1");
  }
  return c;
}

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
   * Customer-facing service lines (reworked Sam, 2026-07-30):
   * - measurement_design = base_cents + round_trip_miles × travel_cents_per_mile.
   *   Since v4 the design base is $0 — the line bills scan-visit travel only.
   * - delivery_install: SHIPPED, not driven (v4). Line = shipping_base_cents +
   *   shipping_cents_per_sqft × physical foam sqft (design sqft × copies).
   *   travel_cents_per_mile is retained as a legacy field: configs keep it (0 in
   *   v4) so pre-v4 engine builds still validate, and the engine falls back to
   *   the travel model when the shipping fields are absent (v2/v3 configs).
   */
  services: {
    measurement_design: { label: string; base_cents: number; travel_cents_per_mile: number };
    delivery_install: {
      label: string;
      /** Legacy travel model (v2/v3). Used only when shipping fields are absent. */
      travel_cents_per_mile: number;
      /** v4+: flat shipping base, cents. */
      shipping_base_cents?: number;
      /** v4+: cents per sqft of PHYSICAL foam shipped (design sqft × copies). */
      shipping_cents_per_sqft?: number;
    };
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
  version: 4,
  currency: "USD",
  product: {
    // Rates cover foam material + cutting + scan labor. No separate labor
    // lines — see services below.
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
    per_drawer_cents: 0, // v4: no per-drawer floor — drawers price purely by sqft × tier rate
    per_order_cents: 25000, // $250 / order (kept as the small-job backstop)
  },
  services: {
    measurement_design: {
      label: "On-site Measurement & Design",
      base_cents: 0, // v4: design base dropped — the line is scan-visit travel only
      travel_cents_per_mile: 125, // $1.25 / round-trip mile (scan visit)
    },
    delivery_install: {
      label: "Delivery & Installation",
      travel_cents_per_mile: 0, // legacy field, unused when shipping fields are set
      shipping_base_cents: 1500, // $15 flat shipping/handling
      shipping_cents_per_sqft: 150, // $1.50 per sqft of physical foam shipped
    },
  },
  upgrades: {},
  costs: {
    mileage_cents_per_round_trip_mile: 70, // $0.70 / round-trip mile
    driving_labor_cents_per_hour: 2000, // $20 / hr
    scanning_labor_cents_per_hour: 2000, // $20 / hr
    install_labor_cents_per_hour: 2000, // $20 / hr (only counts if install hours entered)
    scanning_minutes_per_sqft: 5,
    default_trips: 1, // v4: scan visit only — delivery ships instead of a second trip
  },
  margin: { target: 0.6 },
  rounding: { line: "cent", total: "cent" },
};

/**
 * Per-quote overrides of the active rate card (Sam, 2026-08-01: EVERY knob is
 * overridable in the quote generator, tier rates included). All values are
 * integer cents. An override object is stored on the quote (inputs.config_overrides)
 * so a custom-priced quote is auditable and reproducible; the margin flag stays
 * the guardrail against underpricing.
 */
export type PricingOverrides = {
  tier_rates_cents_per_sqft?: Partial<Record<Tier, number>>;
  /** Measurement & Design flat base (v4 default 0). */
  measurement_base_cents?: number;
  /** Scan-visit travel rate, cents per round-trip mile. */
  measurement_travel_cents_per_mile?: number;
  /** Shipping flat base for Delivery & Installation. */
  shipping_base_cents?: number;
  /** Shipping per sqft of physical foam. */
  shipping_cents_per_sqft?: number;
  /** Per-drawer floor (v4 default 0 = none). */
  per_drawer_min_cents?: number;
  /** Order minimum backstop. */
  per_order_min_cents?: number;
};

/**
 * Merge validated overrides into a copy of the config. The input config is not
 * mutated. Overriding either shipping field forces the shipping delivery model,
 * filling the other field from the config (or 0) so the pair stays complete.
 */
export function applyConfigOverrides(config: PricingConfig, overrides: PricingOverrides): PricingConfig {
  const c: PricingConfig = JSON.parse(JSON.stringify(config));
  const o = overrides;
  if (o.tier_rates_cents_per_sqft) {
    c.product.tier_rates_cents_per_sqft = {
      ...c.product.tier_rates_cents_per_sqft,
      ...o.tier_rates_cents_per_sqft,
    };
    // Keep the legacy fallback aligned with the essential rate.
    if (o.tier_rates_cents_per_sqft.essential != null) {
      c.product.rate_cents_per_sqft = o.tier_rates_cents_per_sqft.essential;
    }
  }
  if (o.measurement_base_cents != null) c.services.measurement_design.base_cents = o.measurement_base_cents;
  if (o.measurement_travel_cents_per_mile != null) {
    c.services.measurement_design.travel_cents_per_mile = o.measurement_travel_cents_per_mile;
  }
  if (o.shipping_base_cents != null || o.shipping_cents_per_sqft != null) {
    c.services.delivery_install.shipping_base_cents =
      o.shipping_base_cents ?? c.services.delivery_install.shipping_base_cents ?? 0;
    c.services.delivery_install.shipping_cents_per_sqft =
      o.shipping_cents_per_sqft ?? c.services.delivery_install.shipping_cents_per_sqft ?? 0;
  }
  if (o.per_drawer_min_cents != null) c.minimums.per_drawer_cents = o.per_drawer_min_cents;
  if (o.per_order_min_cents != null) c.minimums.per_order_cents = o.per_order_min_cents;
  return c;
}

/**
 * Validate an untrusted overrides blob. Unknown keys are dropped; every value
 * must be integer cents ≥ 0 (tier keys must be real tiers). Returns a clean
 * object — {} means "no overrides".
 */
export function sanitizeOverrides(raw: unknown): PricingOverrides {
  const out: PricingOverrides = {};
  if (raw == null || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const cents = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  if (r.tier_rates_cents_per_sqft != null && typeof r.tier_rates_cents_per_sqft === "object") {
    const tiers: Partial<Record<Tier, number>> = {};
    for (const [k, v] of Object.entries(r.tier_rates_cents_per_sqft as Record<string, unknown>)) {
      const c = cents(v);
      if (isTier(k) && c != null) tiers[k] = c;
    }
    if (Object.keys(tiers).length > 0) out.tier_rates_cents_per_sqft = tiers;
  }
  for (const key of [
    "measurement_base_cents",
    "measurement_travel_cents_per_mile",
    "shipping_base_cents",
    "shipping_cents_per_sqft",
    "per_drawer_min_cents",
    "per_order_min_cents",
  ] as const) {
    const c = cents(r[key]);
    if (c != null) out[key] = c;
  }
  return out;
}

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
  // v4 shipping model: both fields or neither (a lone one is a config typo).
  const hasShipBase = di.shipping_base_cents != null;
  const hasShipSqft = di.shipping_cents_per_sqft != null;
  if (hasShipBase !== hasShipSqft) {
    throw new Error("pricing config: delivery_install shipping_base_cents and shipping_cents_per_sqft must be set together");
  }
  if (hasShipBase && (!isCents(di.shipping_base_cents) || !isCents(di.shipping_cents_per_sqft))) {
    throw new Error("pricing config: delivery_install shipping fields must be integer cents");
  }
  if (!c.costs || !isCents(c.costs.mileage_cents_per_round_trip_mile)) {
    throw new Error("pricing config: costs missing");
  }
  if (!c.margin || typeof c.margin.target !== "number" || c.margin.target <= 0 || c.margin.target >= 1) {
    throw new Error("pricing config: margin.target must be between 0 and 1");
  }
  return c;
}

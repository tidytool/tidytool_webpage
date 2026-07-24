/**
 * Drawer-dimension normalizer.
 *
 * `drawer.dimensions` is a `json` blob with real schema drift in production
 * (see claude/portal-supabase-todo-2026-07-18.md §B). Two generations coexist:
 *
 *   legacy  : { length, width, thickness: 0.5,        units: "in" | "mm" }
 *   current : { height, width, thickness: "oneHalf",  unit: "feetDecimal",
 *               original_unit, top_color, base_color, calibration_*, ... }
 *
 * plus strays: thickness as an object ({label,value,unit}), missing thickness,
 * and a nested legacy `colors` object. Everything downstream of this module —
 * the whole pricing engine — sees only NormalizedDrawerDims and never touches
 * raw JSON. Reads coalesce `height ?? length` and `unit ?? units` per
 * PORTAL-B1.
 */

export type NormalizedDrawerDims = {
  width_in: number;
  length_in: number;
  /** Foam sheet thickness in inches. Null = unreadable; engine substitutes the config default. */
  thickness_in: number | null;
  /** (width_in × length_in) / 144 */
  area_sqft: number;
  /** Non-fatal notes: assumptions made while normalizing (surfaced on the quote). */
  warnings: string[];
};

export type NormalizeFailure = { error: string };

export type NormalizeResult = NormalizedDrawerDims | NormalizeFailure;

export function isNormalizeFailure(r: NormalizeResult): r is NormalizeFailure {
  return (r as NormalizeFailure).error !== undefined;
}

/** Multiplier that converts a unit into inches. */
function inchesFactor(unit: string): number | null {
  switch (unit.trim().toLowerCase()) {
    case "in":
    case "inch":
    case "inches":
      return 1;
    case "feetdecimal":
    case "ft":
    case "feet":
      return 12;
    case "mm":
    case "millimeter":
    case "millimeters":
      return 1 / 25.4;
    case "cm":
    case "centimeter":
    case "centimeters":
      return 1 / 2.54;
    case "m":
    case "meter":
    case "meters":
      return 1 / 0.0254;
    default:
      return null;
  }
}

/** tidyCAM's thickness enum → inches. */
const THICKNESS_ENUM_IN: Record<string, number> = {
  onequarter: 0.25,
  onehalf: 0.5,
  threequarter: 0.75,
  threequarters: 0.75,
  threefourths: 0.75,
  one: 1,
  oneandahalf: 1.5,
  oneandhalf: 1.5,
  two: 2,
};

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Thickness arrives as a number (0.5), a numeric string ("0.5"), an enum
 * ("oneHalf"), or an object ({label:'3/4"', value:0.75, unit:'in'}) — all seen
 * in production. Thickness is ALWAYS interpreted in inches regardless of the
 * drawer's width/length unit (the app writes `oneHalf` = ½" even when the
 * footprint is stored in decimal feet).
 */
function normalizeThickness(raw: unknown, warnings: string[]): number | null {
  if (raw == null) return null;
  const asNumber = toFiniteNumber(raw);
  if (asNumber != null) return asNumber > 0 ? asNumber : null;
  if (typeof raw === "string") {
    const mapped = THICKNESS_ENUM_IN[raw.trim().toLowerCase()];
    if (mapped != null) return mapped;
    // Sometimes the object variant arrives JSON-stringified inside the blob.
    try {
      return normalizeThickness(JSON.parse(raw), warnings);
    } catch {
      warnings.push(`unrecognized thickness "${raw}"`);
      return null;
    }
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const value = toFiniteNumber(o.value);
    if (value != null && value > 0) {
      const unit = typeof o.unit === "string" ? inchesFactor(o.unit) : 1;
      return value * (unit ?? 1);
    }
  }
  return null;
}

/**
 * Normalize one drawer's `dimensions` blob into inches + sqft.
 * Returns { error } when the footprint is unreadable — the engine reports
 * those drawers instead of silently pricing them at zero.
 */
export function normalizeDrawerDimensions(dim: unknown): NormalizeResult {
  let d = dim;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return { error: "dimensions is an unparsable string" };
    }
  }
  if (d == null || typeof d !== "object") {
    return { error: "dimensions missing" };
  }
  const o = d as Record<string, unknown>;
  const warnings: string[] = [];

  // PORTAL-B1 drift mapping: unit ?? units, height ?? length (?? depth).
  const unitRaw =
    (typeof o.unit === "string" && o.unit) ||
    (typeof o.units === "string" && o.units) ||
    null;
  let factor: number;
  if (unitRaw == null) {
    factor = 1;
    warnings.push("no unit on dimensions; assumed inches");
  } else {
    const f = inchesFactor(unitRaw);
    if (f == null) {
      return { error: `unknown dimension unit "${unitRaw}"` };
    }
    factor = f;
  }

  const width = toFiniteNumber(o.width);
  const long = toFiniteNumber(o.height ?? o.length ?? o.depth);
  if (width == null || long == null || width <= 0 || long <= 0) {
    return { error: "width/length missing or non-positive" };
  }

  const width_in = width * factor;
  const length_in = long * factor;

  // A drawer telling us it's under 1" or over 10' on a side is a data bug
  // (usually a unit mix-up), not a real drawer — refuse to price garbage.
  const [lo, hi] = [1, 120];
  if (width_in < lo || width_in > hi || length_in < lo || length_in > hi) {
    return {
      error: `implausible footprint ${round2(width_in)}" × ${round2(length_in)}" — check units`,
    };
  }

  const thickness_in = normalizeThickness(o.thickness, warnings);

  return {
    width_in: round4(width_in),
    length_in: round4(length_in),
    thickness_in: thickness_in == null ? null : round4(thickness_in),
    area_sqft: round4((width_in * length_in) / 144),
    warnings,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

"use server";

/**
 * Quote server actions. Pricing happens here — in the TS engine
 * (@/lib/pricing) against the ACTIVE pricing_config row — and the computed
 * result is persisted through the save_quote RPC, which re-validates the
 * arithmetic and is is_staff()-guarded in-database (defense in depth, same
 * posture as ../actions.ts).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { computeQuote, type ComputedQuote, type QuoteInputs } from "@/lib/pricing/engine";
import {
  applyConfigOverrides,
  parsePricingConfig,
  sanitizeOverrides,
  TIERS,
  type PricingConfig,
  type PricingOverrides,
} from "@/lib/pricing/config";

function num(formData: FormData, key: string): number | null {
  const v = formData.get(key);
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Dollar form field → integer cents (null when blank/invalid). */
function cents(formData: FormData, key: string): number | null {
  const n = num(formData, key);
  return n == null ? null : Math.round(n * 100);
}

/**
 * Build the per-quote overrides by DIFFING the submitted rate knobs against the
 * active config: a knob left at its default produces no override, so a normal
 * quote records config_overrides = {} and never reads as custom-priced.
 */
function overridesFrom(formData: FormData, config: PricingConfig): PricingOverrides {
  const raw: Record<string, unknown> = {};
  const tierRates: Record<string, number> = {};
  for (const tier of TIERS) {
    const v = cents(formData, `rate_${tier}`);
    const current = config.product.tier_rates_cents_per_sqft?.[tier] ?? config.product.rate_cents_per_sqft;
    if (v != null && v !== current) tierRates[tier] = v;
  }
  if (Object.keys(tierRates).length > 0) raw.tier_rates_cents_per_sqft = tierRates;

  const knob = (field: string, key: keyof PricingOverrides, current: number | null | undefined) => {
    const v = cents(formData, field);
    if (v != null && v !== (current ?? null)) raw[key] = v;
  };
  knob("design_base", "measurement_base_cents", config.services.measurement_design.base_cents);
  knob("travel_per_mile", "measurement_travel_cents_per_mile", config.services.measurement_design.travel_cents_per_mile);
  knob("ship_base", "shipping_base_cents", config.services.delivery_install.shipping_base_cents);
  knob("ship_per_sqft", "shipping_cents_per_sqft", config.services.delivery_install.shipping_cents_per_sqft);
  knob("drawer_min", "per_drawer_min_cents", config.minimums.per_drawer_cents);
  knob("order_min", "per_order_min_cents", config.minimums.per_order_cents);
  return sanitizeOverrides(raw);
}

type PricedQuote = {
  ok: true;
  orderId: string;
  configId: string;
  inputs: QuoteInputs;
  overrides: PricingOverrides;
  quote: ComputedQuote;
};

/**
 * Shared pricing core: load config + drawers, diff the rate knobs into
 * overrides, and compute — WITHOUT saving. Used by both the Preview action and
 * the save path, so what you preview is exactly what saves.
 */
async function priceQuote(formData: FormData): Promise<PricedQuote | { ok: false; error: string }> {
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) return { ok: false, error: "Missing order id." };

  const miles = num(formData, "round_trip_miles");
  const driveHours = num(formData, "drive_hours_per_trip");
  const installHours = num(formData, "install_hours");
  const trips = num(formData, "trips");
  if (miles == null || driveHours == null || installHours == null) {
    return {
      ok: false,
      error: "Quote needs round-trip miles, drive hours, and install hours (0 is allowed).",
    };
  }

  const supabase = await createClient();

  // 1. Active rate card (RLS: staff-readable).
  const { data: configRow, error: configError } = await supabase
    .from("pricing_config")
    .select("id, config")
    .eq("active", true)
    .single();
  if (configError || !configRow) {
    return { ok: false, error: "No active pricing config — apply the quoting migration first." };
  }

  let config;
  try {
    config = parsePricingConfig(configRow.config);
  } catch (e) {
    return { ok: false, error: `Active pricing config is invalid: ${(e as Error).message}` };
  }

  // 1b. Per-quote rate overrides — knobs left at their defaults diff to {}.
  const overrides = overridesFrom(formData, config);
  const effectiveConfig = Object.keys(overrides).length > 0 ? applyConfigOverrides(config, overrides) : config;

  // 2. The order's drawers (RLS: staff drawer SELECT policy).
  // select("*") on purpose: naming `tier` explicitly would make this action
  // error if the code deploys before migration 20260730120000 adds the column.
  // With "*" the field is simply absent pre-migration and every drawer prices
  // as Essential (the engine's fallback) — no coordinated deploy needed.
  const { data: drawers, error: drawersError } = await supabase
    .from("drawer")
    .select("*")
    .eq("order_id", orderId);
  if (drawersError) return { ok: false, error: drawersError.message };
  if (!drawers || drawers.length === 0) {
    return { ok: false, error: "This order has no drawers to price yet." };
  }

  // 2b. Boxes for this order — physical copies = box.quantity × drawer.quantity.
  const { data: boxes } = await supabase.from("box").select("id, quantity").eq("order_id", orderId);
  const boxQty = new Map<string, number>((boxes ?? []).map((b) => [b.id as string, Number(b.quantity) || 1]));
  const drawerInputs = drawers.map((d) => ({
    id: d.id as string,
    nickname: (d.nickname as string) ?? null,
    dimensions: d.dimensions,
    copies: (d.box_id ? boxQty.get(d.box_id as string) ?? 1 : 1) * (Number(d.quantity) || 1),
    tier: typeof d.tier === "string" ? d.tier : null,
  }));

  // 3. Price (pure, deterministic).
  const inputs: QuoteInputs = {
    round_trip_miles: miles,
    drive_hours_per_trip: driveHours,
    install_hours: installHours,
    ...(trips != null && trips > 0 ? { trips } : {}),
  };
  const quote = computeQuote(drawerInputs, inputs, effectiveConfig);
  if (quote.lines.filter((l) => l.kind === "product").length === 0) {
    const reasons = quote.unpriced_drawers.map((d) => `${d.nickname ?? d.id.slice(0, 8)}: ${d.reason}`).join("; ");
    return { ok: false, error: `No drawer could be priced — ${reasons}` };
  }

  return { ok: true, orderId, configId: configRow.id, inputs, overrides, quote };
}

/** Price + persist through the integrity-checked RPC. */
async function priceAndSaveQuote(
  formData: FormData,
): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
  const priced = await priceQuote(formData);
  if (!priced.ok) return priced;
  const { orderId, configId, inputs, overrides, quote } = priced;

  const supabase = await createClient();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const { error: saveError } = await supabase.rpc("save_quote", {
    p_order_id: orderId,
    p_config_id: configId,
    p_quote: {
      subtotal_cents: quote.subtotal_cents,
      total_cents: quote.total_cents,
      // Overrides ride inside the inputs jsonb so a custom-priced quote is
      // auditable and reproducible without any schema change.
      inputs: Object.keys(overrides).length > 0 ? { ...inputs, config_overrides: overrides } : inputs,
      estimated_cost_cents: quote.estimated_cost_cents,
      cost_breakdown: quote.cost_breakdown,
      gross_profit_cents: quote.gross_profit_cents,
      gross_margin: quote.gross_margin,
      margin_target: quote.margin_target,
      warnings: quote.warnings,
      unpriced_drawers: quote.unpriced_drawers,
    },
    p_lines: quote.lines,
    p_notes: notes,
  });
  if (saveError) return { ok: false, error: saveError.message };

  return { ok: true, orderId };
}

/** Serializable preview line for the modal. */
export type QuotePreviewLine = {
  description: string;
  qty: number | null;
  unit_price_cents: number | null;
  amount_cents: number;
};

/** Shape returned to the modal's Preview button via useActionState. */
export type QuotePreviewState = {
  ok?: boolean;
  error?: string;
  preview?: {
    lines: QuotePreviewLine[];
    total_cents: number;
    estimated_cost_cents: number;
    gross_margin: number | null;
    below_target: boolean;
    warnings: string[];
    unpriced: string[];
    override_count: number;
  };
};

/**
 * Preview action: full pricing pass, NOTHING saved. What renders here is
 * byte-identical to what "Generate quote" would persist with the same form.
 */
export async function quotePreviewAction(
  _prev: QuotePreviewState,
  formData: FormData,
): Promise<QuotePreviewState> {
  const priced = await priceQuote(formData);
  if (!priced.ok) return { error: priced.error };
  const { quote, overrides } = priced;
  return {
    ok: true,
    preview: {
      lines: quote.lines.map((l) => ({
        description: l.description,
        qty: l.qty,
        unit_price_cents: l.unit_price_cents,
        amount_cents: l.amount_cents,
      })),
      total_cents: quote.total_cents,
      estimated_cost_cents: quote.estimated_cost_cents,
      gross_margin: quote.gross_margin,
      below_target: quote.below_target,
      warnings: quote.warnings,
      unpriced: quote.unpriced_drawers.map((d) => `${d.nickname ?? d.id.slice(0, 8)}: ${d.reason}`),
      override_count: Object.keys(overrides).length,
    },
  };
}

/** Legacy redirect-style action (kept for compatibility; UI now uses quoteFormAction). */
export async function createQuoteAction(formData: FormData) {
  const res = await priceAndSaveQuote(formData);
  const orderId = String(formData.get("order_id") ?? "");
  const back = `/admin/orders/${orderId}`;
  if (!res.ok) redirect(`${back}?error=${encodeURIComponent(res.error)}`);
  revalidatePath(back);
}

/** Shape returned to the Generate-quote modal via useActionState. */
export type QuoteFormState = { ok?: boolean; error?: string };

/**
 * Return-style Generate-quote action for the modal. Errors come back as state
 * (rendered inside the dialog) and success returns { ok: true } so the client
 * can close the overlay — no page-level ?error= redirect for the happy path.
 */
export async function quoteFormAction(
  _prev: QuoteFormState,
  formData: FormData,
): Promise<QuoteFormState> {
  const res = await priceAndSaveQuote(formData);
  if (!res.ok) return { error: res.error };
  revalidatePath(`/admin/orders/${res.orderId}`);
  return { ok: true };
}

export async function setQuoteStatusAction(formData: FormData) {
  const quoteId = String(formData.get("quote_id") ?? "");
  const orderId = String(formData.get("order_id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!quoteId || !status) throw new Error("Missing quote id or status.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_quote_status", {
    p_quote_id: quoteId,
    p_status: status,
  });
  const back = orderId ? `/admin/orders/${orderId}` : "/admin/orders";
  if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(back);
  revalidatePath("/admin/orders");
}

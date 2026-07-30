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
import { computeQuote, type QuoteInputs } from "@/lib/pricing/engine";
import { parsePricingConfig } from "@/lib/pricing/config";

function num(formData: FormData, key: string): number | null {
  const v = formData.get(key);
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Core pricing routine shared by the (legacy) redirect-style action and the
 * new return-style action the Generate-quote modal uses. Returns a discriminated
 * result instead of throwing/redirecting so either caller can shape the outcome.
 */
async function priceAndSaveQuote(
  formData: FormData,
): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
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
  const quote = computeQuote(drawerInputs, inputs, config);
  if (quote.lines.filter((l) => l.kind === "product").length === 0) {
    const reasons = quote.unpriced_drawers.map((d) => `${d.nickname ?? d.id.slice(0, 8)}: ${d.reason}`).join("; ");
    return { ok: false, error: `No drawer could be priced — ${reasons}` };
  }

  // 4. Persist through the integrity-checked RPC.
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const { error: saveError } = await supabase.rpc("save_quote", {
    p_order_id: orderId,
    p_config_id: configRow.id,
    p_quote: {
      subtotal_cents: quote.subtotal_cents,
      total_cents: quote.total_cents,
      inputs,
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

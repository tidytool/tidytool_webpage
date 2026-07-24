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

export async function createQuoteAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("Missing order id.");
  const back = `/admin/orders/${orderId}`;

  const miles = num(formData, "round_trip_miles");
  const driveHours = num(formData, "drive_hours_per_trip");
  const installHours = num(formData, "install_hours");
  const trips = num(formData, "trips");
  if (miles == null || driveHours == null || installHours == null) {
    redirect(`${back}?error=${encodeURIComponent("Quote needs round-trip miles, drive hours, and install hours (0 is allowed).")}`);
  }

  const supabase = await createClient();

  // 1. Active rate card (RLS: staff-readable).
  const { data: configRow, error: configError } = await supabase
    .from("pricing_config")
    .select("id, config")
    .eq("active", true)
    .single();
  if (configError || !configRow) {
    redirect(`${back}?error=${encodeURIComponent("No active pricing config — apply the quoting migration first.")}`);
  }

  let config;
  try {
    config = parsePricingConfig(configRow.config);
  } catch (e) {
    redirect(`${back}?error=${encodeURIComponent(`Active pricing config is invalid: ${(e as Error).message}`)}`);
  }

  // 2. The order's drawers (RLS: staff drawer SELECT policy).
  const { data: drawers, error: drawersError } = await supabase
    .from("drawer")
    .select("id, nickname, dimensions")
    .eq("order_id", orderId);
  if (drawersError) redirect(`${back}?error=${encodeURIComponent(drawersError.message)}`);
  if (!drawers || drawers.length === 0) {
    redirect(`${back}?error=${encodeURIComponent("This order has no drawers to price yet.")}`);
  }

  // 3. Price (pure, deterministic).
  const inputs: QuoteInputs = {
    round_trip_miles: miles!,
    drive_hours_per_trip: driveHours!,
    install_hours: installHours!,
    ...(trips != null && trips > 0 ? { trips } : {}),
  };
  const quote = computeQuote(drawers!, inputs, config!);
  if (quote.lines.filter((l) => l.kind === "product").length === 0) {
    const reasons = quote.unpriced_drawers.map((d) => `${d.nickname ?? d.id.slice(0, 8)}: ${d.reason}`).join("; ");
    redirect(`${back}?error=${encodeURIComponent(`No drawer could be priced — ${reasons}`)}`);
  }

  // 4. Persist through the integrity-checked RPC.
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const { error: saveError } = await supabase.rpc("save_quote", {
    p_order_id: orderId,
    p_config_id: configRow!.id,
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
  if (saveError) redirect(`${back}?error=${encodeURIComponent(saveError.message)}`);

  revalidatePath(back);
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

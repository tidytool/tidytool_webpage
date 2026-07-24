"use server";

/**
 * Save the order's site address + saved round-trip distance (admin_set_order_site).
 * The distance pre-fills the quote form so miles are entered once per order
 * rather than re-typed (and mistyped) on every quote.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function updateOrderSiteAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("Missing order id.");
  const back = `/admin/orders/${orderId}`;

  const address = String(formData.get("site_address") ?? "").trim();
  const milesRaw = String(formData.get("round_trip_miles") ?? "").trim();
  let miles: number | null = null;
  if (milesRaw !== "") {
    const n = Number(milesRaw.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      redirect(`${back}?error=${encodeURIComponent("Round-trip miles must be a non-negative number.")}`);
    }
    miles = n;
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_order_site", {
    p_order_id: orderId,
    p_site_address: address === "" ? null : address,
    p_round_trip_miles: miles,
  });
  if (error) redirect(`${back}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(back);
}

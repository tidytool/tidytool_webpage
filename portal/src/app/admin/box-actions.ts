"use server";

/**
 * Box-management server actions for the admin order page. Each wraps a
 * SECURITY DEFINER RPC that re-checks is_admin() in the database (defense in
 * depth, same posture as ./actions.ts). Failures redirect back with ?error=.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function backTo(orderId: string): string {
  return `/admin/orders/${orderId}`;
}

export async function createBoxAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const qtyRaw = String(formData.get("quantity") ?? "1");
  const quantity = Math.max(1, Math.floor(Number(qtyRaw) || 1));
  if (!orderId) throw new Error("Missing order id.");
  if (!label) redirect(`${backTo(orderId)}?error=${encodeURIComponent("A box label is required.")}`);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_create_box", {
    p_order_id: orderId,
    p_label: label,
    p_quantity: quantity,
  });
  if (error) redirect(`${backTo(orderId)}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(backTo(orderId));
}

export async function updateBoxAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const boxId = String(formData.get("box_id") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const qtyRaw = String(formData.get("quantity") ?? "").trim();
  if (!orderId || !boxId) throw new Error("Missing ids.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_box", {
    p_box_id: boxId,
    p_label: label || null,
    p_quantity: qtyRaw === "" ? null : Math.max(1, Math.floor(Number(qtyRaw) || 1)),
  });
  if (error) redirect(`${backTo(orderId)}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(backTo(orderId));
}

export async function deleteBoxAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const boxId = String(formData.get("box_id") ?? "");
  if (!orderId || !boxId) throw new Error("Missing ids.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_delete_box", { p_box_id: boxId });
  if (error) redirect(`${backTo(orderId)}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(backTo(orderId));
}

/** Assign a drawer to a box, or pass an empty box id to make it a tray. */
export async function assignDrawerToBoxAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const drawerId = String(formData.get("drawer_id") ?? "");
  const boxId = String(formData.get("box_id") ?? "").trim();
  if (!orderId || !drawerId) throw new Error("Missing ids.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_drawer_to_box", {
    p_drawer_id: drawerId,
    p_box_id: boxId === "" ? null : boxId,
  });
  if (error) redirect(`${backTo(orderId)}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(backTo(orderId));
}

export async function setDrawerQuantityAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const drawerId = String(formData.get("drawer_id") ?? "");
  const quantity = Math.max(1, Math.floor(Number(formData.get("quantity")) || 1));
  if (!orderId || !drawerId) throw new Error("Missing ids.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_drawer_quantity", {
    p_drawer_id: drawerId,
    p_quantity: quantity,
  });
  if (error) redirect(`${backTo(orderId)}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(backTo(orderId));
}

/** Combined box-placement + copies for one drawer (one "Apply" in the UI). */
export async function updateDrawerPlacementAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const drawerId = String(formData.get("drawer_id") ?? "");
  const boxId = String(formData.get("box_id") ?? "").trim();
  const quantity = Math.max(1, Math.floor(Number(formData.get("quantity")) || 1));
  if (!orderId || !drawerId) throw new Error("Missing ids.");

  const supabase = await createClient();
  const { error: assignErr } = await supabase.rpc("assign_drawer_to_box", {
    p_drawer_id: drawerId,
    p_box_id: boxId === "" ? null : boxId,
  });
  if (assignErr) redirect(`${backTo(orderId)}?error=${encodeURIComponent(assignErr.message)}`);
  const { error: qtyErr } = await supabase.rpc("admin_set_drawer_quantity", {
    p_drawer_id: drawerId,
    p_quantity: quantity,
  });
  if (qtyErr) redirect(`${backTo(orderId)}?error=${encodeURIComponent(qtyErr.message)}`);
  revalidatePath(backTo(orderId));
}

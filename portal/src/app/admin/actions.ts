"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Admin server actions. Every RPC below is SECURITY DEFINER and re-checks
 * is_admin() inside the database, so these are defense-in-depth wrappers —
 * a non-admin invoking them gets a Postgres 42501, not data.
 */

export async function assignOrderAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const customerId = String(formData.get("customer_id") ?? "");
  if (!orderId || !customerId) throw new Error("Pick a customer first.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_order_to_customer", {
    p_order_id: orderId,
    p_customer_id: customerId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

export async function createCustomerAndAssignAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  if (!orderId || !name) throw new Error("A customer name is required.");

  const supabase = await createClient();
  const { data: customerId, error: createError } = await supabase.rpc(
    "admin_create_customer",
    { p_name: name, p_email: email || null, p_phone: phone || null },
  );
  if (createError) throw new Error(createError.message);

  const { error: assignError } = await supabase.rpc("assign_order_to_customer", {
    p_order_id: orderId,
    p_customer_id: customerId,
  });
  if (assignError) throw new Error(assignError.message);
  revalidatePath("/admin");
}

export async function markDeliveredAction(formData: FormData) {
  const drawerId = String(formData.get("drawer_id") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!drawerId) throw new Error("Missing drawer id.");

  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_drawer_delivered", {
    p_drawer_id: drawerId,
    p_note: note || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

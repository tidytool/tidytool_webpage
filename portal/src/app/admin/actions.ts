"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

/** Null when blank so the RPC treats it as "unchanged"; '' only when explicitly clearing. */
function opt(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  if (v == null) return null;
  const s = String(v);
  return s.trim() === "" ? null : s.trim();
}

export async function updateOrderAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("Missing order id.");
  const priceRaw = opt(formData, "total_price_dollars");
  let cents: number | null = null;
  if (priceRaw != null) {
    const dollars = Number(priceRaw.replace(/[$,]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) throw new Error("Invalid price.");
    cents = Math.round(dollars * 100);
  }
  const countRaw = opt(formData, "drawer_count");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_order", {
    p_order_id: orderId,
    p_customer_name: opt(formData, "customer_name"),
    p_customer_email: opt(formData, "customer_email"),
    p_customer_phone: opt(formData, "customer_phone"),
    p_project_name: opt(formData, "project_name"),
    p_location: opt(formData, "location"),
    p_notes: opt(formData, "notes"),
    p_drawer_count: countRaw == null ? null : Number(countRaw),
    p_total_price_cents: cents,
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
}

export async function updateCustomerAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  if (!customerId) throw new Error("Missing customer id.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_customer", {
    p_customer_id: customerId,
    p_name: opt(formData, "name"),
    p_email: opt(formData, "email"),
    p_phone: opt(formData, "phone"),
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/customers");
}

export async function setCustomerOrgAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  const orgId = String(formData.get("organization_id") ?? "");
  if (!customerId) throw new Error("Missing customer id.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_customer_organization", {
    p_customer_id: customerId,
    p_organization_id: orgId || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/customers");
}

export async function createOrgAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Organization name required.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_create_organization", { p_name: name });
  if (error) redirect(`/admin/organizations?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/customers");
}

export async function mergeCustomersAction(formData: FormData) {
  const keep = String(formData.get("keep_id") ?? "");
  const merge = String(formData.get("merge_id") ?? "");
  if (!keep || !merge) throw new Error("Pick a customer to merge.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_merge_customers", {
    p_keep: keep,
    p_merge: merge,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/customers");
  revalidatePath("/admin/orders");
}

export async function updateNicknameAction(formData: FormData) {
  const drawerId = String(formData.get("drawer_id") ?? "");
  const orderId = String(formData.get("order_id") ?? "");
  if (!drawerId) throw new Error("Missing drawer id.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_drawer_nickname", {
    p_drawer_id: drawerId,
    p_nickname: String(formData.get("nickname") ?? ""),
  });
  if (error) throw new Error(error.message);
  if (orderId) revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin");
}

export async function createCustomerAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("A customer name is required.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_create_customer", {
    p_name: name,
    p_email: opt(formData, "email"),
    p_phone: opt(formData, "phone"),
  });
  if (error) redirect(`/admin/customers?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/customers");
}

// ---------------------------------------------------------------------------
// Create / delete / bulk (T3.5b). Delete failures redirect back with ?error=
// instead of throwing, so guard violations ("customer has orders") read as a
// friendly banner, not a crash page.
// ---------------------------------------------------------------------------

export async function createOrderAction(formData: FormData) {
  const name = String(formData.get("customer_name") ?? "").trim();
  if (!name) throw new Error("A customer name is required.");
  const priceRaw = opt(formData, "total_price_dollars");
  let cents: number | null = null;
  if (priceRaw != null) {
    const dollars = Number(priceRaw.replace(/[$,]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) throw new Error("Invalid price.");
    cents = Math.round(dollars * 100);
  }
  const countRaw = opt(formData, "drawer_count");
  const supabase = await createClient();
  const { data: orderId, error } = await supabase.rpc("admin_create_order", {
    p_customer_name: name,
    p_customer_email: opt(formData, "customer_email"),
    p_customer_phone: opt(formData, "customer_phone"),
    p_project_name: opt(formData, "project_name"),
    p_location: opt(formData, "location"),
    p_notes: opt(formData, "notes"),
    p_drawer_count: countRaw == null ? null : Number(countRaw),
    p_total_price_cents: cents,
    p_customer_id: opt(formData, "customer_id"),
  });
  if (error) redirect(`/admin/orders?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/orders");
  revalidatePath("/admin");
  redirect(`/admin/orders/${orderId}`);
}

export async function deleteOrderAction(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  if (!orderId) throw new Error("Missing order id.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_delete_order", { p_order_id: orderId });
  if (error) {
    redirect(`/admin/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  }
  revalidatePath("/admin/orders");
  revalidatePath("/admin");
  redirect("/admin/orders");
}

export async function deleteCustomerAction(formData: FormData) {
  const customerId = String(formData.get("customer_id") ?? "");
  if (!customerId) throw new Error("Missing customer id.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_delete_customer", {
    p_customer_id: customerId,
  });
  if (error) redirect(`/admin/customers?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/customers");
}

export async function deleteOrgAction(formData: FormData) {
  const orgId = String(formData.get("organization_id") ?? "");
  if (!orgId) throw new Error("Missing organization id.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_delete_organization", {
    p_organization_id: orgId,
  });
  if (error) redirect(`/admin/organizations?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/customers");
}

export async function renameOrgAction(formData: FormData) {
  const orgId = String(formData.get("organization_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!orgId || !name) throw new Error("Organization name required.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_rename_organization", {
    p_organization_id: orgId,
    p_name: name,
  });
  if (error) redirect(`/admin/organizations?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/customers");
}

/** Called from the bulk-select client component; returns instead of throwing. */
export async function bulkAssignOrders(
  orderIds: string[],
  customerId: string,
): Promise<{ error?: string; assigned?: number }> {
  if (!orderIds.length) return { error: "No orders selected." };
  if (!customerId) return { error: "Pick a customer first." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_bulk_assign_orders", {
    p_order_ids: orderIds,
    p_customer_id: customerId,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/admin/orders");
  return { assigned: (data as { assigned?: number })?.assigned ?? orderIds.length };
}

/** Called from the bulk-select client component; returns instead of throwing. */
export async function bulkDeleteOrders(
  orderIds: string[],
): Promise<{ error?: string; deleted?: number }> {
  if (!orderIds.length) return { error: "No orders selected." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_bulk_delete_orders", {
    p_order_ids: orderIds,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin");
  revalidatePath("/admin/orders");
  return { deleted: (data as { deleted?: number })?.deleted ?? orderIds.length };
}

/** Set/clear a customer's organization. Client-callable (auto-save on change). */
export async function setCustomerOrg(
  customerId: string,
  orgId: string,
): Promise<{ error?: string }> {
  if (!customerId) return { error: "Missing customer id." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_customer_organization", {
    p_customer_id: customerId,
    p_organization_id: orgId || null,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin/customers");
  return {};
}

/** Bulk delete customers (unlinks their orders first). Client-callable. */
export async function bulkDeleteCustomers(
  customerIds: string[],
): Promise<{ error?: string; deleted?: number }> {
  if (!customerIds.length) return { error: "No customers selected." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_bulk_delete_customers", {
    p_customer_ids: customerIds,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin/customers");
  revalidatePath("/admin");
  revalidatePath("/admin/orders");
  return { deleted: (data as { deleted?: number })?.deleted ?? customerIds.length };
}

/** Bulk delete empty organizations. Client-callable. */
export async function bulkDeleteOrganizations(
  orgIds: string[],
): Promise<{ error?: string; deleted?: number }> {
  if (!orgIds.length) return { error: "No organizations selected." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_bulk_delete_organizations", {
    p_organization_ids: orgIds,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin/organizations");
  revalidatePath("/admin/customers");
  return { deleted: (data as { deleted?: number })?.deleted ?? orgIds.length };
}

/** Bulk hard-delete drawers (+ their events). Client-callable. */
export async function bulkDeleteDrawers(
  drawerIds: string[],
): Promise<{ error?: string; deleted?: number }> {
  if (!drawerIds.length) return { error: "No drawers selected." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_bulk_delete_drawers", {
    p_drawer_ids: drawerIds,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin");
  return { deleted: (data as { deleted?: number })?.deleted ?? drawerIds.length };
}

/** Bulk mark drawers delivered with one shared note. Client-callable. */
export async function bulkMarkDelivered(
  drawerIds: string[],
  note: string,
): Promise<{ error?: string; delivered?: number }> {
  if (!drawerIds.length) return { error: "No drawers selected." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_bulk_mark_delivered", {
    p_drawer_ids: drawerIds,
    p_note: note.trim() || null,
  });
  if (error) return { error: error.message };
  revalidatePath("/admin");
  return { delivered: (data as { delivered?: number })?.delivered ?? drawerIds.length };
}

// ---------------------------------------------------------------------------
// Portal access (auth-user management). These use the SERVICE-ROLE client,
// which bypasses RLS — so unlike the RPC wrappers above, we must verify the
// caller is an admin here, ourselves, before doing anything.
// ---------------------------------------------------------------------------

async function requireAdmin(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_admin");
  if (error) return error.message;
  if (data !== true) return "Not authorized.";
  return null;
}

function portalRedirectTo(): string {
  // Preview/dev deploys must never send invite links pointing at prod, so the
  // hardcoded domain is the last resort, after Vercel's per-deploy URL.
  const site =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://app.thetidytool.com");
  return `${site}/auth/confirm?next=/set-password`;
}

/** Friendlier message when the auth user already exists. */
function inviteErrorMessage(raw: string): string {
  if (/already.*(registered|exists|been invited)/i.test(raw)) {
    return "That email already has a portal account. Ask them to use “Email me a link” on the sign-in page, or set a new password for them below.";
  }
  return raw;
}

/** Send a Supabase invite email; the link lands on /set-password. Client-callable. */
export async function invitePortalUser(
  email: string,
): Promise<{ error?: string; ok?: boolean }> {
  const addr = email.trim().toLowerCase();
  if (!addr) return { error: "This customer has no email on file. Add one first." };
  const denied = await requireAdmin();
  if (denied) return { error: denied };

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(addr, {
    redirectTo: portalRedirectTo(),
  });
  if (error) return { error: inviteErrorMessage(error.message) };
  revalidatePath("/admin/customers");
  return { ok: true };
}

/** Create (or reset) a login with a password you hand to the customer directly.
 *  Fallback for flaky email. Client-callable. */
export async function createPortalLoginWithPassword(
  email: string,
  password: string,
): Promise<{ error?: string; ok?: boolean }> {
  const addr = email.trim().toLowerCase();
  if (!addr) return { error: "This customer has no email on file. Add one first." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  const denied = await requireAdmin();
  if (denied) return { error: denied };

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { error } = await admin.auth.admin.createUser({
    email: addr,
    password,
    email_confirm: true, // no confirmation email — Sam relays the password
  });
  if (!error) {
    revalidatePath("/admin/customers");
    return { ok: true };
  }

  // Already registered? Treat as a password reset for the existing user.
  if (/already.*(registered|exists)/i.test(error.message)) {
    const { data: page, error: listErr } = await admin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (listErr) return { error: listErr.message };
    const existing = page.users.find((u) => u.email?.toLowerCase() === addr);
    if (!existing) return { error: "Account exists but couldn't be found to reset." };
    const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, {
      password,
    });
    if (updErr) return { error: updErr.message };
    revalidatePath("/admin/customers");
    return { ok: true };
  }

  return { error: error.message };
}

// ---------------------------------------------------------------------------
// Employees (staff-role management). grant/revoke go through the normal
// session client — the RPCs are SECURITY DEFINER and re-check is_admin()
// in the database, which is the real security boundary. No service role.
// ---------------------------------------------------------------------------

type StaffRpcResult = { ok: boolean; user_id?: string; error?: string };

/** Grant the 'staff' role by email. Idempotent. Client-callable. */
export async function grantStaffRole(
  email: string,
): Promise<{ error?: string; ok?: boolean }> {
  const addr = email.trim().toLowerCase();
  if (!addr) return { error: "Enter an email address." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("grant_staff_role", { p_email: addr });
  if (error) return { error: error.message };
  const res = data as StaffRpcResult;
  if (!res?.ok) return { error: res?.error ?? "Grant failed." };
  revalidatePath("/admin/employees");
  return { ok: true };
}

/** Revoke the 'staff' role by email. Cannot touch 'admin'. Client-callable. */
export async function revokeStaffRole(
  email: string,
): Promise<{ error?: string; ok?: boolean }> {
  const addr = email.trim().toLowerCase();
  if (!addr) return { error: "Enter an email address." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("revoke_staff_role", { p_email: addr });
  if (error) return { error: error.message };
  const res = data as StaffRpcResult;
  if (!res?.ok) return { error: res?.error ?? "Revoke failed." };
  revalidatePath("/admin/employees");
  return { ok: true };
}

/** Invite a new employee: service-role invite email creates the auth user,
 *  then staff is granted through the normal session client. Client-callable. */
export async function inviteEmployeeAndGrantStaff(
  email: string,
): Promise<{ error?: string; ok?: boolean }> {
  const addr = email.trim().toLowerCase();
  if (!addr) return { error: "Enter an email address." };
  const denied = await requireAdmin();
  if (denied) return { error: denied };

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(addr, {
    redirectTo: portalRedirectTo(),
  });
  // "Already registered" is fine here — the account exists, so just grant.
  if (inviteErr && !/already.*(registered|exists|been invited)/i.test(inviteErr.message)) {
    return { error: inviteErr.message };
  }
  return grantStaffRole(addr);
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

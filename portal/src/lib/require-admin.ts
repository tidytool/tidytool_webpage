import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Page-level gate for admin-only tabs, now that the /admin layout also admits
 * staff. UX only — every admin RPC still re-checks is_admin() in the
 * database — so a staff user typing the URL lands back on the Pipeline
 * instead of a raw error banner.
 */
export async function requireAdminPage(): Promise<void> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("is_admin");
  if (data !== true) redirect("/admin");
}

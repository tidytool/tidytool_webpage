import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { AdminTabs } from "@/components/AdminTabs";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";

/**
 * Admin shell: UX-level gate + sub-nav. Staff are admitted too (is_staff()
 * covers admins) and see the read-only tabs; admin-only tabs re-gate
 * themselves via requireAdminPage(). Real enforcement lives in the database —
 * every RPC re-checks is_admin()/is_staff() server-side.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const claims = await getClaims();
  if (!claims) redirect("/login");
  const email = (claims.email as string | undefined) ?? undefined;

  const supabase = await createClient();
  const [adminRes, staffRes] = await Promise.all([
    supabase.rpc("is_admin"),
    supabase.rpc("is_staff"),
  ]);
  const isAdmin = adminRes.data === true;
  if (!isAdmin && staffRes.data !== true) redirect("/");

  return (
    <>
      <Header email={email} isAdmin />
      <div className="wrap wrap--wide" style={{ paddingTop: "1rem", paddingBottom: 0 }}>
        <AdminTabs isAdmin={isAdmin} />
      </div>
      {children}
    </>
  );
}

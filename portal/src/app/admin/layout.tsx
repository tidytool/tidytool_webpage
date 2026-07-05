import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { AdminTabs } from "@/components/AdminTabs";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";

/**
 * Admin shell: UX-level gate + sub-nav. Real enforcement lives in the
 * database — every admin RPC re-checks is_admin() server-side.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const claims = await getClaims();
  if (!claims) redirect("/login");
  const email = (claims.email as string | undefined) ?? undefined;

  const supabase = await createClient();
  const { data: isAdmin, error } = await supabase.rpc("is_admin");
  if (error || !isAdmin) redirect("/");

  return (
    <>
      <Header email={email} isAdmin />
      <div className="wrap wrap--wide" style={{ paddingTop: "1rem", paddingBottom: 0 }}>
        <AdminTabs />
      </div>
      {children}
    </>
  );
}

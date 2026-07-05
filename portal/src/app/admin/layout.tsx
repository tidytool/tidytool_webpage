import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
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

  const tabs = [
    { href: "/admin", label: "Pipeline" },
    { href: "/admin/orders", label: "Orders" },
    { href: "/admin/customers", label: "Customers" },
    { href: "/admin/audit", label: "Audit" },
  ];

  return (
    <>
      <Header email={email} isAdmin />
      <nav className="wrap" style={{ paddingBottom: 0 }}>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", borderBottom: "1px solid var(--c-border)", paddingBottom: "0.6rem" }}>
          {tabs.map((t) => (
            <a key={t.href} href={t.href} style={{ fontWeight: 700, fontSize: "0.95rem" }}>
              {t.label}
            </a>
          ))}
        </div>
      </nav>
      {children}
    </>
  );
}

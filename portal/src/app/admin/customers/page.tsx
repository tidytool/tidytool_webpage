import { createClient } from "@/lib/supabase/server";
import { requireAdminPage } from "@/lib/require-admin";
import { type AdminCustomer, type AdminOrganization } from "@/lib/types";
import { createCustomerAction } from "../actions";
import { CustomersList } from "@/components/CustomersList";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdminPage();
  const sp = await searchParams;
  const supabase = await createClient();
  const [custRes, orgRes] = await Promise.all([
    supabase.rpc("get_admin_customers"),
    supabase.rpc("get_admin_organizations"),
  ]);
  const customers = (custRes.data ?? []) as AdminCustomer[];
  const organizations = (orgRes.data ?? []) as AdminOrganization[];

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Customers</h1>
          <p className="muted sub num">
            {customers.length} customer{customers.length === 1 ? "" : "s"}.
            Every change is logged in History. Deleting a customer unlinks
            their orders (they become unassigned); merging repoints a
            duplicate&apos;s orders instead.
          </p>
        </div>
      </div>

      {sp.error ? <p className="banner--err" role="alert">{sp.error}</p> : null}
      {custRes.error ? <p className="banner--err" role="alert">{custRes.error.message}</p> : null}

      <form action={createCustomerAction} className="card" style={{ marginTop: "1.1rem" }}>
        <h2>New customer</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
          <input name="name" placeholder="Name (required)" required style={{ flex: "1 1 160px", minWidth: 0 }} />
          <input name="email" type="email" placeholder="Email" style={{ flex: "1 1 180px", minWidth: 0 }} />
          <input name="phone" placeholder="Phone" style={{ flex: "1 1 120px", minWidth: 0 }} />
          <button className="btn btn--primary" type="submit">Create</button>
        </div>
      </form>

      <CustomersList customers={customers} organizations={organizations} />
    </main>
  );
}

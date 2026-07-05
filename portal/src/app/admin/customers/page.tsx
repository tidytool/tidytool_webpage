import { createClient } from "@/lib/supabase/server";
import { type AdminCustomer } from "@/lib/types";
import {
  updateCustomerAction,
  setCustomerOrgAction,
  createOrgAction,
  mergeCustomersAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_admin_customers");
  const customers = (data ?? []) as AdminCustomer[];
  const orgs = Array.from(
    new Map(
      customers
        .filter((c) => c.organization_id)
        .map((c) => [c.organization_id as string, c.organization_name ?? "Unnamed org"]),
    ).entries(),
  );

  return (
    <main className="wrap">
      <p className="eyebrow">Admin</p>
      <h1>Customers</h1>
      {error ? <p className="muted">Error: {error.message}</p> : null}
      <p className="muted">
        {customers.length} customer{customers.length === 1 ? "" : "s"}. Every change
        here is audit-logged. Merging repoints all of a duplicate&apos;s orders, then
        removes it — the merged record is preserved in the audit log.
      </p>

      <form action={createOrgAction} className="card" style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input name="name" placeholder="New organization name" required style={{ flex: "1 1 220px" }} />
        <button className="btn btn--ghost" type="submit">Create organization</button>
      </form>

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {customers.map((c) => (
          <li key={c.customer_id} className="card" style={{ marginTop: "0.75rem" }}>
            <form action={updateCustomerAction} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end" }}>
              <input type="hidden" name="customer_id" value={c.customer_id} />
              <label style={{ flex: "1 1 150px" }}>
                <span className="muted" style={{ fontSize: "0.8rem" }}>Name</span>
                <input name="name" defaultValue={c.name ?? ""} style={{ width: "100%" }} />
              </label>
              <label style={{ flex: "1 1 190px" }}>
                <span className="muted" style={{ fontSize: "0.8rem" }}>Email</span>
                <input name="email" type="email" defaultValue={c.email ?? ""} style={{ width: "100%" }} />
              </label>
              <label style={{ flex: "1 1 130px" }}>
                <span className="muted" style={{ fontSize: "0.8rem" }}>Phone</span>
                <input name="phone" style={{ width: "100%" }} />
              </label>
              <button className="btn btn--ghost" type="submit">Save</button>
            </form>

            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
              <form action={setCustomerOrgAction} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <input type="hidden" name="customer_id" value={c.customer_id} />
                <select name="organization_id" defaultValue={c.organization_id ?? ""}>
                  <option value="">No organization</option>
                  {orgs.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
                <button className="btn btn--ghost" type="submit">Set org</button>
              </form>

              <details>
                <summary className="muted" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                  Merge a duplicate into this record…
                </summary>
                <form action={mergeCustomersAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                  <input type="hidden" name="keep_id" value={c.customer_id} />
                  <select name="merge_id" required defaultValue="">
                    <option value="" disabled>Duplicate to absorb…</option>
                    {customers
                      .filter((x) => x.customer_id !== c.customer_id)
                      .map((x) => (
                        <option key={x.customer_id} value={x.customer_id}>
                          {x.name || x.email || x.customer_id}
                          {x.email && x.name ? ` (${x.email})` : ""}
                        </option>
                      ))}
                  </select>
                  <button className="btn btn--ghost" type="submit">Merge</button>
                </form>
              </details>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}

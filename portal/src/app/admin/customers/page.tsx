import { createClient } from "@/lib/supabase/server";
import { type AdminCustomer, type AdminOrganization } from "@/lib/types";
import {
  updateCustomerAction,
  setCustomerOrgAction,
  createOrgAction,
  mergeCustomersAction,
  createCustomerAction,
  deleteCustomerAction,
  deleteOrgAction,
  renameOrgAction,
} from "../actions";
import { ConfirmButton } from "@/components/ConfirmButton";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
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
            {customers.length} customer{customers.length === 1 ? "" : "s"} ·{" "}
            {organizations.length} organization{organizations.length === 1 ? "" : "s"}.
            Every change is audit-logged.
          </p>
        </div>
      </div>

      {sp.error ? <p className="banner--err" role="alert">{sp.error}</p> : null}
      {custRes.error ? <p className="banner--err" role="alert">{custRes.error.message}</p> : null}

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginTop: "1.1rem" }}>
        <form action={createCustomerAction} className="card">
          <h2>New customer</h2>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
            <input name="name" placeholder="Name (required)" required style={{ flex: "1 1 140px", minWidth: 0 }} />
            <input name="email" type="email" placeholder="Email" style={{ flex: "1 1 160px", minWidth: 0 }} />
            <input name="phone" placeholder="Phone" style={{ flex: "1 1 110px", minWidth: 0 }} />
            <button className="btn btn--primary" type="submit">Create</button>
          </div>
        </form>

        <form action={createOrgAction} className="card">
          <h2>New organization</h2>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
            <input name="name" placeholder="Organization name" required style={{ flex: "1 1 200px", minWidth: 0 }} />
            <button className="btn btn--primary" type="submit">Create</button>
          </div>
        </form>
      </div>

      {organizations.length > 0 ? (
        <section style={{ marginTop: "1.5rem" }}>
          <h2>Organizations</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {organizations.map((g) => {
              const empty = g.customer_count === 0 && g.order_count === 0;
              return (
                <li key={g.organization_id} className="card" style={{ marginTop: "0.7rem", display: "flex", gap: "0.7rem", alignItems: "center", flexWrap: "wrap" }}>
                  <form action={renameOrgAction} style={{ display: "flex", gap: "0.5rem", flex: "1 1 260px", minWidth: 0 }}>
                    <input type="hidden" name="organization_id" value={g.organization_id} />
                    <input name="name" defaultValue={g.name} required style={{ flex: 1, minWidth: 0 }} aria-label={`Rename ${g.name}`} />
                    <button className="btn btn--ghost" type="submit">Rename</button>
                  </form>
                  <span className="chip num">
                    <strong>{g.customer_count}</strong> customers · <strong>{g.order_count}</strong> orders
                  </span>
                  <form action={deleteOrgAction}>
                    <input type="hidden" name="organization_id" value={g.organization_id} />
                    {empty ? (
                      <ConfirmButton message={`Delete organization "${g.name}"?`} className="btn btn--sm btn--danger">
                        Delete
                      </ConfirmButton>
                    ) : (
                      <button className="btn btn--sm btn--danger" disabled title="Reassign its customers and orders first">
                        Delete
                      </button>
                    )}
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section style={{ marginTop: "1.5rem" }}>
        <h2>All customers</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {customers.map((c) => {
            const deletable = c.order_count === 0 && !c.has_login;
            return (
              <li key={c.customer_id} className="card" style={{ marginTop: "0.7rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", alignItems: "center" }}>
                    <span className="chip num">Orders <strong>{c.order_count}</strong></span>
                    {c.has_login ? <span className="badge badge--approved">Portal login</span> : null}
                    {c.organization_name ? <span className="chip">{c.organization_name}</span> : null}
                  </div>
                  <form action={deleteCustomerAction}>
                    <input type="hidden" name="customer_id" value={c.customer_id} />
                    {deletable ? (
                      <ConfirmButton
                        message={`Delete customer "${c.name || c.email || "unnamed"}"?`}
                        className="btn btn--sm btn--danger"
                      >
                        Delete
                      </ConfirmButton>
                    ) : (
                      <button
                        className="btn btn--sm btn--danger"
                        disabled
                        title={c.has_login ? "Has a portal login" : "Has orders — merge instead"}
                      >
                        Delete
                      </button>
                    )}
                  </form>
                </div>

                <form action={updateCustomerAction} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginTop: "0.8rem" }}>
                  <input type="hidden" name="customer_id" value={c.customer_id} />
                  <label className="ctrl" style={{ flex: "1 1 150px" }}>
                    <span>Name</span>
                    <input name="name" defaultValue={c.name ?? ""} />
                  </label>
                  <label className="ctrl" style={{ flex: "1 1 190px" }}>
                    <span>Email</span>
                    <input name="email" type="email" defaultValue={c.email ?? ""} />
                  </label>
                  <label className="ctrl" style={{ flex: "1 1 130px" }}>
                    <span>Phone</span>
                    <input name="phone" defaultValue={c.phone ?? ""} />
                  </label>
                  <button className="btn btn--ghost" type="submit">Save</button>
                </form>

                <div style={{ display: "flex", gap: "0.9rem", flexWrap: "wrap", marginTop: "0.7rem", alignItems: "center" }}>
                  <form action={setCustomerOrgAction} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input type="hidden" name="customer_id" value={c.customer_id} />
                    <select name="organization_id" defaultValue={c.organization_id ?? ""} aria-label="Organization">
                      <option value="">No organization</option>
                      {organizations.map((g) => (
                        <option key={g.organization_id} value={g.organization_id}>{g.name}</option>
                      ))}
                    </select>
                    <button className="btn btn--ghost btn--sm" type="submit">Set org</button>
                  </form>

                  <details className="reveal">
                    <summary>Merge a duplicate into this record</summary>
                    <form action={mergeCustomersAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
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
                      <button className="btn btn--ghost btn--sm" type="submit">Merge</button>
                    </form>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

import { createClient } from "@/lib/supabase/server";
import { type AdminOrderRow, type AdminCustomer, formatCents } from "@/lib/types";

export const dynamic = "force-dynamic";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type Search = { q?: string; org?: string; email?: string; from?: string; to?: string };

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  // Distinct orgs for the filter dropdown (via customers list; cheap at this scale).
  const { data: custData } = await supabase.rpc("get_admin_customers");
  const customers = (custData ?? []) as AdminCustomer[];
  const orgs = Array.from(
    new Map(
      customers
        .filter((c) => c.organization_id)
        .map((c) => [c.organization_id as string, c.organization_name ?? "Unnamed org"]),
    ).entries(),
  );

  // p_to is exclusive in the RPC — push the "to" date to the next midnight.
  const toExclusive = sp.to
    ? new Date(new Date(`${sp.to}T00:00:00Z`).getTime() + 86_400_000).toISOString()
    : null;

  const { data, error } = await supabase.rpc("get_admin_orders", {
    p_search: sp.q || null,
    p_organization_id: sp.org || null,
    p_email: sp.email || null,
    p_from: sp.from ? `${sp.from}T00:00:00Z` : null,
    p_to: toExclusive,
  });
  const orders = (data ?? []) as AdminOrderRow[];

  return (
    <main className="wrap">
      <p className="eyebrow">Admin</p>
      <h1>Orders</h1>
      {error ? <p className="muted">Error: {error.message}</p> : null}

      <form method="get" className="card" style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ flex: "2 1 200px" }}>
          <span className="muted" style={{ fontSize: "0.8rem" }}>Search</span>
          <input name="q" defaultValue={sp.q ?? ""} placeholder="name, email, project, notes" style={{ width: "100%" }} />
        </label>
        <label style={{ flex: "1 1 160px" }}>
          <span className="muted" style={{ fontSize: "0.8rem" }}>Customer email</span>
          <input name="email" defaultValue={sp.email ?? ""} style={{ width: "100%" }} />
        </label>
        <label style={{ flex: "1 1 160px" }}>
          <span className="muted" style={{ fontSize: "0.8rem" }}>Organization</span>
          <select name="org" defaultValue={sp.org ?? ""} style={{ width: "100%" }}>
            <option value="">Any</option>
            {orgs.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted" style={{ fontSize: "0.8rem" }}>From</span>
          <input type="date" name="from" defaultValue={sp.from ?? ""} />
        </label>
        <label>
          <span className="muted" style={{ fontSize: "0.8rem" }}>To</span>
          <input type="date" name="to" defaultValue={sp.to ?? ""} />
        </label>
        <button className="btn btn--ghost" type="submit">Filter</button>
        <a href="/admin/orders" className="muted" style={{ fontSize: "0.85rem" }}>reset</a>
      </form>

      <p className="muted" style={{ marginTop: "1rem" }}>
        {orders.length} order{orders.length === 1 ? "" : "s"}
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {orders.map((o) => (
          <li key={o.order_id} className="card" style={{ marginTop: "0.6rem" }}>
            <a href={`/admin/orders/${o.order_id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                <div>
                  <strong>{o.customer_name || "Unknown"}</strong>
                  {o.project_name ? <span className="muted"> — {o.project_name}</span> : null}
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {o.customer_email || "no email"}
                    {o.organization_name ? ` · ${o.organization_name}` : ""}
                    {o.customer_id ? "" : " · UNASSIGNED"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div>{formatCents(o.total_price) ?? "—"}</div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {fmtDate(o.created_at)} · {o.drawer_rows} drawer{o.drawer_rows === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

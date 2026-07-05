import { createClient } from "@/lib/supabase/server";
import { type AdminOrderRow, type AdminCustomer, formatCents } from "@/lib/types";
import { createOrderAction } from "../actions";

export const dynamic = "force-dynamic";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type Search = { q?: string; org?: string; email?: string; from?: string; to?: string; error?: string };

const FILTER_KEYS = ["q", "email", "org", "from", "to"] as const;
const FILTER_LABELS: Record<(typeof FILTER_KEYS)[number], string> = {
  q: "Search", email: "Email", org: "Org", from: "From", to: "To",
};

/** URL for the same view with one filter removed (powers the chip ×). */
function hrefWithout(sp: Search, drop: string) {
  const params = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    if (k !== drop && sp[k]) params.set(k, sp[k] as string);
  }
  const qs = params.toString();
  return qs ? `/admin/orders?${qs}` : "/admin/orders";
}

const GRID = "minmax(220px, 2fr) minmax(140px, 1.2fr) 5rem 6.5rem 7.5rem";

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: custData } = await supabase.rpc("get_admin_customers");
  const customers = (custData ?? []) as AdminCustomer[];
  const orgs = Array.from(
    new Map(
      customers
        .filter((c) => c.organization_id)
        .map((c) => [c.organization_id as string, c.organization_name ?? "Unnamed org"]),
    ).entries(),
  );
  const orgName = (id: string) => new Map(orgs).get(id) ?? id;

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

  const applied = FILTER_KEYS.filter((k) => sp[k]);

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Orders</h1>
          <p className="muted sub num">
            {orders.length} order{orders.length === 1 ? "" : "s"}
            {applied.length ? " matching filters" : ""}
          </p>
        </div>
      </div>

      {sp.error ? <p className="banner--err" role="alert">{sp.error}</p> : null}
      {error ? <p className="banner--err" role="alert">{error.message}</p> : null}

      <form method="get" className="toolbar">
        <label className="ctrl" style={{ flex: "2 1 220px" }}>
          <span>Search</span>
          <input name="q" defaultValue={sp.q ?? ""} placeholder="Name, email, project, notes…" />
        </label>
        <label className="ctrl" style={{ flex: "1 1 170px" }}>
          <span>Customer email</span>
          <input name="email" defaultValue={sp.email ?? ""} placeholder="name@company.com" />
        </label>
        <label className="ctrl" style={{ flex: "1 1 160px" }}>
          <span>Organization</span>
          <select name="org" defaultValue={sp.org ?? ""}>
            <option value="">Any</option>
            {orgs.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <label className="ctrl">
          <span>From</span>
          <input type="date" name="from" defaultValue={sp.from ?? ""} />
        </label>
        <label className="ctrl">
          <span>To</span>
          <input type="date" name="to" defaultValue={sp.to ?? ""} />
        </label>
        <button className="btn btn--primary" type="submit">Apply</button>
      </form>

      {applied.length > 0 ? (
        <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.8rem" }}>
          {applied.map((k) => (
            <span key={k} className="fchip">
              <span>
                <span>{FILTER_LABELS[k]}:</span>{" "}
                {k === "org" ? orgName(sp.org as string) : sp[k]}
              </span>
              <a href={hrefWithout(sp, k)} aria-label={`Remove ${FILTER_LABELS[k]} filter`}>✕</a>
            </span>
          ))}
          <a href="/admin/orders" className="muted" style={{ fontSize: "0.83rem", fontWeight: 600 }}>
            Clear all
          </a>
        </div>
      ) : null}

      <details className="reveal" style={{ marginTop: "1.1rem" }}>
        <summary>New order (manual entry)</summary>
        <form action={createOrderAction} className="card" style={{ marginTop: "0.6rem", display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <label className="ctrl">
            <span>Customer name *</span>
            <input name="customer_name" required placeholder="Jane Smith" />
          </label>
          <label className="ctrl">
            <span>Email</span>
            <input name="customer_email" type="email" placeholder="Auto-links a customer" />
          </label>
          <label className="ctrl">
            <span>Phone</span>
            <input name="customer_phone" />
          </label>
          <label className="ctrl">
            <span>Project</span>
            <input name="project_name" />
          </label>
          <label className="ctrl">
            <span>Location</span>
            <input name="location" />
          </label>
          <label className="ctrl">
            <span>Price ($)</span>
            <input name="total_price_dollars" inputMode="decimal" placeholder="0.00" />
          </label>
          <label className="ctrl">
            <span>Drawer count</span>
            <input name="drawer_count" type="number" min="0" />
          </label>
          <label className="ctrl">
            <span>Link to existing customer</span>
            <select name="customer_id" defaultValue="">
              <option value="">Auto (match by email)</option>
              {customers.map((c) => (
                <option key={c.customer_id} value={c.customer_id}>
                  {c.name || c.email || c.customer_id}
                  {c.organization_name ? ` — ${c.organization_name}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="ctrl" style={{ gridColumn: "1 / -1" }}>
            <span>Notes</span>
            <input name="notes" />
          </label>
          <div>
            <button className="btn btn--primary" type="submit">Create order</button>
          </div>
        </form>
      </details>

      <div className="table" role="table" aria-label="Orders">
        <div className="trow trow--head" role="row" style={{ gridTemplateColumns: GRID }}>
          <span>Customer / project</span>
          <span>Organization</span>
          <span className="tr-right">Drawers</span>
          <span className="tr-right">Total</span>
          <span className="tr-right">Created</span>
        </div>
        {orders.length === 0 ? (
          <div className="trow muted" style={{ gridTemplateColumns: "1fr" }}>
            No orders match. <a href="/admin/orders">Clear filters</a>
          </div>
        ) : (
          orders.map((o) => (
            <a key={o.order_id} className="trow" href={`/admin/orders/${o.order_id}`} style={{ gridTemplateColumns: GRID }}>
              <span>
                <span className="primary">{o.customer_name || "Unknown"}</span>
                {o.project_name ? <span className="muted"> — {o.project_name}</span> : null}
                <br />
                <span className="sub">
                  {o.customer_email || "no email"}
                  {!o.customer_id ? <> · <span className="badge badge--warn">Unassigned</span></> : null}
                </span>
              </span>
              <span className="sub hide-sm">{o.organization_name ?? "—"}</span>
              <span className="tr-right num hide-sm">{o.drawer_rows}</span>
              <span className="tr-right num">{formatCents(o.total_price) ?? "—"}</span>
              <span className="tr-right sub num hide-sm">{fmtDate(o.created_at)}</span>
            </a>
          ))
        )}
      </div>
    </main>
  );
}

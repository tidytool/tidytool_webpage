import { createClient } from "@/lib/supabase/server";
import {
  type AdminOrderDetail,
  type AdminCustomer,
  STATUS_LABELS,
  formatCents,
} from "@/lib/types";
import {
  updateOrderAction,
  updateNicknameAction,
  markDeliveredAction,
  assignOrderAction,
} from "../../actions";

export const dynamic = "force-dynamic";

function Model3D({ url }: { url: string }) {
  const isUsdz = url.toLowerCase().endsWith(".usdz");
  return (
    <details style={{ marginTop: "0.4rem" }}>
      <summary className="muted" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
        Load 3D model
      </summary>
      <p style={{ margin: "0.4rem 0 0", fontSize: "0.9rem" }}>
        {isUsdz ? (
          <a href={url} rel="ar noopener noreferrer">
            Open scan in 3D (QuickLook) →
          </a>
        ) : (
          <a href={url} download>
            Download model file →
          </a>
        )}
      </p>
    </details>
  );
}

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const [detailRes, custRes] = await Promise.all([
    supabase.rpc("get_admin_order_detail", { p_order_id: id }),
    supabase.rpc("get_admin_customers"),
  ]);

  if (detailRes.error) {
    return (
      <main className="wrap">
        <h1>Order</h1>
        <p className="muted">{detailRes.error.message}</p>
      </main>
    );
  }
  const detail = detailRes.data as AdminOrderDetail;
  const customers = (custRes.data ?? []) as AdminCustomer[];
  const o = detail.order;

  return (
    <main className="wrap">
      <p className="eyebrow">
        <a href="/admin/orders">← Orders</a>
      </p>
      <h1>{o.project_name || o.customer_name || "Order"}</h1>
      <p className="muted">
        Created {new Date(o.created_at).toLocaleDateString()} ·{" "}
        {formatCents(o.total_price) ?? "no price"} ·{" "}
        {detail.customer
          ? `Linked to ${detail.customer.name || detail.customer.email}`
          : "UNASSIGNED"}
        {detail.organization ? ` (${detail.organization.name})` : ""}
      </p>

      <section className="card" style={{ marginTop: "1rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Edit order</h2>
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.8rem" }}>
          Blank fields stay unchanged. Every save is written to the audit log.
        </p>
        <form action={updateOrderAction} style={{ display: "grid", gap: "0.6rem", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <input type="hidden" name="order_id" value={o.id} />
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Customer name</span>
            <input name="customer_name" defaultValue={o.customer_name ?? ""} style={{ width: "100%" }} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Customer email</span>
            <input name="customer_email" type="email" defaultValue={o.customer_email ?? ""} style={{ width: "100%" }} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Phone</span>
            <input name="customer_phone" defaultValue={o.customer_phone ?? ""} style={{ width: "100%" }} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Project</span>
            <input name="project_name" defaultValue={o.project_name ?? ""} style={{ width: "100%" }} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Location</span>
            <input name="location" defaultValue={o.location ?? ""} style={{ width: "100%" }} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Price ($)</span>
            <input name="total_price_dollars" inputMode="decimal" defaultValue={o.total_price != null ? (o.total_price / 100).toFixed(2) : ""} style={{ width: "100%" }} />
          </label>
          <label>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Drawer count</span>
            <input name="drawer_count" type="number" min="0" defaultValue={o.drawer_count ?? ""} style={{ width: "100%" }} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <span className="muted" style={{ fontSize: "0.8rem" }}>Notes</span>
            <input name="notes" defaultValue={o.notes ?? ""} style={{ width: "100%" }} />
          </label>
          <div>
            <button className="btn btn--ghost" type="submit">Save order</button>
          </div>
        </form>

        <form action={assignOrderAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
          <input type="hidden" name="order_id" value={o.id} />
          <select name="customer_id" required defaultValue="" style={{ flex: "1 1 220px" }}>
            <option value="" disabled>
              {detail.customer ? "Reassign to another customer…" : "Assign to customer…"}
            </option>
            {customers.map((c) => (
              <option key={c.customer_id} value={c.customer_id}>
                {c.name || c.email || c.customer_id}
                {c.organization_name ? ` — ${c.organization_name}` : ""}
              </option>
            ))}
          </select>
          <button className="btn btn--ghost" type="submit">
            {detail.customer ? "Reassign" : "Assign"}
          </button>
        </form>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.2rem" }}>Drawers ({detail.drawers.length})</h2>
        <div style={{ display: "grid", gap: "1rem", marginTop: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {detail.drawers.map((d) => {
            const stage = d.status ? STATUS_LABELS[d.status] ?? d.status : "—";
            return (
              <div key={d.id} className="card">
                <strong>{d.nickname || "Untitled drawer"}</strong>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                  <span className="chip">Stage <strong>{stage}</strong></span>
                  <span className="chip">Approval <strong>{d.customer_approval_status}</strong></span>
                </div>
                {d.photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={d.photo_url}
                    alt={d.nickname ? `Photo of ${d.nickname}` : "Drawer photo"}
                    loading="lazy"
                    style={{ width: "100%", borderRadius: "8px", marginTop: "0.6rem" }}
                  />
                ) : (
                  <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.6rem" }}>No photo</p>
                )}
                {d.design_preview_url ? (
                  <p style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
                    <a href={d.design_preview_url} target="_blank" rel="noopener noreferrer">Design preview →</a>
                  </p>
                ) : null}
                {d.point_cloud_url ? <Model3D url={d.point_cloud_url} /> : null}

                <form action={updateNicknameAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.7rem" }}>
                  <input type="hidden" name="drawer_id" value={d.id} />
                  <input type="hidden" name="order_id" value={o.id} />
                  <input name="nickname" defaultValue={d.nickname ?? ""} placeholder="Nickname" style={{ flex: 1, minWidth: 0 }} />
                  <button className="btn btn--ghost" type="submit">Rename</button>
                </form>
                <form action={markDeliveredAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                  <input type="hidden" name="drawer_id" value={d.id} />
                  <input name="note" placeholder="Delivery note (optional)" style={{ flex: 1, minWidth: 0 }} />
                  <button className="btn btn--ghost" type="submit">Delivered</button>
                </form>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

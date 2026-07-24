import { createClient } from "@/lib/supabase/server";
import {
  type AdminOrderDetail,
  type AdminCustomer,
  type AdminQuote,
  STATUS_LABELS,
  formatCents,
} from "@/lib/types";
import { QuotesSection } from "@/components/QuotesSection";
import {
  updateOrderAction,
  updateNicknameAction,
  markDeliveredAction,
  assignOrderAction,
  deleteOrderAction,
} from "../../actions";
import { createBoxAction } from "../../box-actions";
import { updateOrderSiteAction, lookupOrderDistanceAction } from "../../site-actions";
import { BoxCard } from "@/components/BoxCard";
import { DrawerBoxControls } from "@/components/DrawerBoxControls";
import { ConfirmButton } from "@/components/ConfirmButton";

export const dynamic = "force-dynamic";

function Model3D({ url }: { url: string }) {
  const isUsdz = url.toLowerCase().endsWith(".usdz");
  return (
    <details className="reveal" style={{ marginTop: "0.4rem" }}>
      <summary>Load 3D model</summary>
      <p style={{ margin: "0.4rem 0 0", fontSize: "0.9rem" }}>
        {isUsdz ? (
          <a href={url} rel="ar noopener noreferrer">Open scan in 3D (QuickLook) →</a>
        ) : (
          <a href={url} download>Download model file →</a>
        )}
      </p>
    </details>
  );
}

export default async function AdminOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const [detailRes, custRes, quotesRes] = await Promise.all([
    supabase.rpc("get_admin_order_detail", { p_order_id: id }),
    supabase.rpc("get_admin_customers"),
    supabase.rpc("get_quotes_for_order", { p_order_id: id }),
  ]);

  if (detailRes.error) {
    return (
      <main className="wrap wrap--wide">
        <h1>Order</h1>
        <p className="banner--err">{detailRes.error.message}</p>
      </main>
    );
  }
  const detail = detailRes.data as AdminOrderDetail;
  const customers = (custRes.data ?? []) as AdminCustomer[];
  // Absent until the quoting migration is applied — render nothing rather than crash.
  const quotes = (quotesRes.error ? [] : (quotesRes.data ?? [])) as AdminQuote[];
  const o = detail.order;

  // Current physical-copy structure — used to flag quotes priced before a change.
  const currentDrawerCopies = detail.drawers.map((d) => {
    const box = detail.boxes.find((b) => b.id === d.box_id) ?? null;
    return { id: d.id, copies: (box ? box.quantity : 1) * d.quantity };
  });

  return (
    <main className="wrap wrap--wide">
      <p className="eyebrow" style={{ marginTop: "0.25rem" }}>
        <a href="/admin/orders">← Orders</a>
      </p>
      <div className="page-head">
        <div>
          <h1>{o.project_name || o.customer_name || "Order"}</h1>
          <p className="muted sub">
            Created {new Date(o.created_at).toLocaleDateString()} ·{" "}
            <span className="num">{formatCents(o.total_price) ?? "no price"}</span>
          </p>
        </div>
        <div>
          {detail.customer ? (
            <span className="chip">
              {detail.customer.name || detail.customer.email}
              {detail.organization ? <strong>{detail.organization.name}</strong> : null}
            </span>
          ) : (
            <span className="badge badge--warn">Unassigned</span>
          )}
        </div>
      </div>

      {sp.error ? <p className="banner--err" role="alert">{sp.error}</p> : null}

      <section className="card" style={{ marginTop: "1.1rem" }}>
        <h2>Edit order</h2>
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.9rem" }}>
          Blank fields stay unchanged. Every save is recorded in History.
        </p>
        <form action={updateOrderAction} style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <input type="hidden" name="order_id" value={o.id} />
          <label className="ctrl">
            <span>Customer name</span>
            <input name="customer_name" defaultValue={o.customer_name ?? ""} />
          </label>
          <label className="ctrl">
            <span>Customer email</span>
            <input name="customer_email" type="email" defaultValue={o.customer_email ?? ""} />
          </label>
          <label className="ctrl">
            <span>Phone</span>
            <input name="customer_phone" defaultValue={o.customer_phone ?? ""} />
          </label>
          <label className="ctrl">
            <span>Project</span>
            <input name="project_name" defaultValue={o.project_name ?? ""} />
          </label>
          <label className="ctrl">
            <span>Location</span>
            <input name="location" defaultValue={o.location ?? ""} />
          </label>
          <label className="ctrl">
            <span>Price ($)</span>
            <input name="total_price_dollars" inputMode="decimal" defaultValue={o.total_price != null ? (o.total_price / 100).toFixed(2) : ""} />
          </label>
          <label className="ctrl">
            <span>Drawer count</span>
            <input name="drawer_count" type="number" min="0" defaultValue={o.drawer_count ?? ""} />
          </label>
          <label className="ctrl" style={{ gridColumn: "1 / -1" }}>
            <span>Notes</span>
            <input name="notes" defaultValue={o.notes ?? ""} />
          </label>
          <div>
            <button className="btn btn--primary" type="submit">Save order</button>
          </div>
        </form>

        <form action={assignOrderAction} style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap", borderTop: "1px solid var(--c-border)", paddingTop: "1rem" }}>
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

        <form action={updateOrderSiteAction} style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap", alignItems: "end", borderTop: "1px solid var(--c-border)", paddingTop: "1rem" }}>
          <input type="hidden" name="order_id" value={o.id} />
          <label className="ctrl" style={{ flex: "1 1 260px" }}>
            <span>Site address (for travel)</span>
            <input name="site_address" defaultValue={o.site_address ?? ""} placeholder="Customer scan/delivery address" />
          </label>
          <label className="ctrl" style={{ flex: "0 0 150px" }}>
            <span>Round-trip miles</span>
            <input name="round_trip_miles" inputMode="decimal" defaultValue={o.round_trip_miles ?? ""} placeholder="e.g. 40" />
          </label>
          <button className="btn btn--ghost" type="submit">Save site</button>
          <button className="btn btn--ghost" type="submit" formAction={lookupOrderDistanceAction}>
            Look up distance
          </button>
          <span className="muted" style={{ fontSize: "0.8rem", flexBasis: "100%" }}>
            &ldquo;Look up distance&rdquo; drives the address against the shop origin and fills round-trip miles
            automatically. The saved distance pre-fills the quote form, so miles are entered once per order.
          </span>
        </form>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Boxes <span className="muted num" style={{ fontWeight: 500 }}>({detail.boxes.length})</span></h2>
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.8rem" }}>
          A box groups drawers that are produced together and duplicate as a unit (e.g. 2 identical
          toolboxes). Quantity = physical copies of the whole box. Drawers not in a box are trays.
          Design is quoted once; foam is quoted per physical copy.
        </p>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          {detail.boxes.map((b) => (
            <BoxCard
              key={b.id}
              orderId={o.id}
              box={{ id: b.id, label: b.label, quantity: b.quantity }}
              drawerCount={detail.drawers.filter((d) => d.box_id === b.id).length}
            />
          ))}
          <form action={createBoxAction} className="card" style={{ flex: "1 1 240px", maxWidth: "300px", display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "end" }}>
            <input type="hidden" name="order_id" value={o.id} />
            <label className="ctrl" style={{ flex: "1 1 120px" }}>
              <span>New box label</span>
              <input name="label" placeholder="e.g. Blue box" required />
            </label>
            <label className="ctrl" style={{ flex: "0 0 70px" }}>
              <span>Copies</span>
              <input name="quantity" type="number" min="1" step="1" defaultValue={1} />
            </label>
            <button className="btn btn--primary" type="submit">Add box</button>
          </form>
        </div>
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h2>Drawers <span className="muted num" style={{ fontWeight: 500 }}>({detail.drawers.length})</span></h2>
        <div style={{ display: "grid", gap: "1rem", marginTop: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {detail.drawers.map((d) => {
            const stage = d.status ? STATUS_LABELS[d.status] ?? d.status : "—";
            const box = detail.boxes.find((b) => b.id === d.box_id) ?? null;
            const physical = (box ? box.quantity : 1) * d.quantity;
            return (
              <div key={d.id} className="card">
                <strong>{d.nickname || "Untitled drawer"}</strong>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                  <span className="chip">Stage <strong>{stage}</strong></span>
                  <span className="chip">Approval <strong>{d.customer_approval_status}</strong></span>
                  <span className="chip">{box ? <>Box <strong>{box.label}</strong></> : <>Tray</>}</span>
                  {physical > 1 ? <span className="chip">Physical <strong>×{physical}</strong></span> : null}
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

                <DrawerBoxControls
                  orderId={o.id}
                  drawer={{ id: d.id, box_id: d.box_id, quantity: d.quantity }}
                  boxes={detail.boxes.map((b) => ({ id: b.id, label: b.label, quantity: b.quantity }))}
                />

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

      <QuotesSection
        orderId={o.id}
        quotes={quotes}
        currentDrawerCopies={currentDrawerCopies}
        defaultMiles={o.round_trip_miles}
      />

      <section className="card card--danger" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ color: "var(--c-danger)" }}>Danger zone</h2>
        <p className="muted" style={{ fontSize: "0.88rem", margin: "0.2rem 0 0.8rem" }}>
          Permanently deletes this order, its {detail.drawers.length} drawer
          {detail.drawers.length === 1 ? "" : "s"}, and their event history.
          A full copy is recorded in History first.
        </p>
        <form action={deleteOrderAction}>
          <input type="hidden" name="order_id" value={o.id} />
          <ConfirmButton
            message={`Delete this order and its ${detail.drawers.length} drawer(s)? This cannot be undone from the UI.`}
            requireText="DELETE"
          >
            Delete order
          </ConfirmButton>
        </form>
      </section>
    </main>
  );
}

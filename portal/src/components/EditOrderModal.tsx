"use client";

/**
 * Order details, assignment, travel/site, and delete — folded out of the main
 * flow into a single overlay opened from the summary header (redesign brief:
 * "any organization and refinement should be an optional path, not in the strict
 * flow"). The forms are the same server actions as before, just relocated; each
 * saves in place (History records every change). Delete lives here as the danger
 * step instead of a red section the page used to end on.
 */
import { Modal } from "@/components/Modal";
import { ConfirmButton } from "@/components/ConfirmButton";
import { updateOrderAction, assignOrderAction, deleteOrderAction } from "@/app/admin/actions";
import { updateOrderSiteAction, lookupOrderDistanceAction } from "@/app/admin/site-actions";
import type { AdminCustomer } from "@/lib/types";

type OrderVM = {
  id: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  project_name: string | null;
  location: string | null;
  notes: string | null;
  drawer_count: number | null;
  total_price: number | null;
  site_address: string | null;
  round_trip_miles: number | null;
};

export function EditOrderModal({
  order,
  customers,
  hasCustomer,
  drawerCount,
}: {
  order: OrderVM;
  customers: AdminCustomer[];
  hasCustomer: boolean;
  drawerCount: number;
}) {
  const o = order;
  return (
    <Modal label="Edit details" title="Edit order" wide>
      <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
        Blank fields stay unchanged. Every save is recorded in History.
      </p>

      <form
        action={updateOrderAction}
        style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
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
          <input
            name="total_price_dollars"
            inputMode="decimal"
            defaultValue={o.total_price != null ? (o.total_price / 100).toFixed(2) : ""}
          />
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
          <button className="btn btn--primary" type="submit">
            Save order
          </button>
        </div>
      </form>

      <form
        action={assignOrderAction}
        style={{
          display: "flex",
          gap: "0.5rem",
          marginTop: "1rem",
          flexWrap: "wrap",
          borderTop: "1px solid var(--c-border)",
          paddingTop: "1rem",
        }}
      >
        <input type="hidden" name="order_id" value={o.id} />
        <select name="customer_id" required defaultValue="" style={{ flex: "1 1 220px" }}>
          <option value="" disabled>
            {hasCustomer ? "Reassign to another customer…" : "Assign to customer…"}
          </option>
          {customers.map((c) => (
            <option key={c.customer_id} value={c.customer_id}>
              {c.name || c.email || c.customer_id}
              {c.organization_name ? ` — ${c.organization_name}` : ""}
            </option>
          ))}
        </select>
        <button className="btn btn--ghost" type="submit">
          {hasCustomer ? "Reassign" : "Assign"}
        </button>
      </form>

      <form
        action={updateOrderSiteAction}
        style={{
          display: "flex",
          gap: "0.5rem",
          marginTop: "1rem",
          flexWrap: "wrap",
          alignItems: "end",
          borderTop: "1px solid var(--c-border)",
          paddingTop: "1rem",
        }}
      >
        <input type="hidden" name="order_id" value={o.id} />
        <label className="ctrl" style={{ flex: "1 1 260px" }}>
          <span>Site address (for travel)</span>
          <input name="site_address" defaultValue={o.site_address ?? ""} placeholder="Customer scan/delivery address" />
        </label>
        <label className="ctrl" style={{ flex: "0 0 150px" }}>
          <span>Round-trip miles</span>
          <input name="round_trip_miles" inputMode="decimal" defaultValue={o.round_trip_miles ?? ""} placeholder="e.g. 40" />
        </label>
        <button className="btn btn--ghost" type="submit">
          Save site
        </button>
        <button className="btn btn--ghost" type="submit" formAction={lookupOrderDistanceAction}>
          Look up distance
        </button>
        <span className="muted" style={{ fontSize: "0.8rem", flexBasis: "100%" }}>
          &ldquo;Look up distance&rdquo; drives the address against the shop origin and fills round-trip miles
          automatically. The saved distance pre-fills the quote, so miles are entered once per order.
        </span>
      </form>

      <div
        style={{
          marginTop: "1.2rem",
          borderTop: "1px solid var(--c-border)",
          paddingTop: "1rem",
        }}
      >
        <h3 style={{ color: "var(--c-danger)", margin: 0 }}>Delete order</h3>
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.7rem" }}>
          Permanently deletes this order, its {drawerCount} drawer{drawerCount === 1 ? "" : "s"}, and their
          event history. A full copy is recorded in History first.
        </p>
        <form action={deleteOrderAction}>
          <input type="hidden" name="order_id" value={o.id} />
          <ConfirmButton
            message={`Delete this order and its ${drawerCount} drawer(s)? This cannot be undone from the UI.`}
            requireText="DELETE"
          >
            Delete order
          </ConfirmButton>
        </form>
      </div>
    </Modal>
  );
}

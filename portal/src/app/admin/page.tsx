import { createClient } from "@/lib/supabase/server";
import {
  type AdminPipelineRow,
  type AdminOrphanOrder,
  type AdminCustomer,
  STATUS_LABELS,
} from "@/lib/types";
import {
  assignOrderAction,
  createCustomerAndAssignAction,
  markDeliveredAction,
} from "./actions";

export const dynamic = "force-dynamic";

function ApprovalBadge({ status }: { status: AdminPipelineRow["customer_approval_status"] }) {
  if (status === "approved") return <span className="badge badge--approved">Approved</span>;
  if (status === "changes_requested") return <span className="badge badge--changes">Changes requested</span>;
  return <span className="badge badge--pending">Awaiting approval</span>;
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function PipelineRow({ d }: { d: AdminPipelineRow }) {
  const stage = d.status ? STATUS_LABELS[d.status] ?? d.status : "—";
  return (
    <li className="card" style={{ marginTop: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "start" }}>
        <div>
          <h3 style={{ fontSize: "1.05rem", margin: 0 }}>
            {d.nickname || "Untitled drawer"}
          </h3>
          <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.9rem" }}>
            {d.customer_name || "No customer"}
            {d.customer_email ? ` · ${d.customer_email}` : ""}
            {d.project_name ? ` · ${d.project_name}` : ""}
          </p>
        </div>
        <ApprovalBadge status={d.customer_approval_status} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center" }}>
        <span className="chip">Stage <strong>{stage}</strong></span>
        {d.approved_at ? (
          <span className="chip">Approved <strong>{formatDate(d.approved_at)}</strong>{d.approved_by ? ` by ${d.approved_by}` : ""}</span>
        ) : null}
        <span className="chip">Created <strong>{formatDate(d.created_at)}</strong></span>
      </div>
      <form action={markDeliveredAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
        <input type="hidden" name="drawer_id" value={d.drawer_id} />
        <input
          name="note"
          placeholder="Delivery note (optional)"
          style={{ flex: "1 1 200px", minWidth: 0 }}
        />
        <button className="btn btn--ghost" type="submit">
          Mark delivered
        </button>
      </form>
    </li>
  );
}

function OrphanCard({ o, customers }: { o: AdminOrphanOrder; customers: AdminCustomer[] }) {
  const price = o.total_price != null ? `$${(o.total_price / 100).toFixed(2)}` : null;
  return (
    <li className="card" style={{ marginTop: "0.75rem" }}>
      <div>
        <h3 style={{ fontSize: "1.05rem", margin: 0 }}>
          {o.customer_name || "Unknown customer"}
          {o.project_name ? ` — ${o.project_name}` : ""}
        </h3>
        <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.9rem" }}>
          {formatDate(o.created_at)}
          {o.drawer_count != null ? ` · ${o.drawer_count} drawer${o.drawer_count === 1 ? "" : "s"}` : ""}
          {price ? ` · ${price}` : ""}
          {o.customer_email ? ` · email: ${o.customer_email}` : " · no email on order"}
        </p>
      </div>

      <form action={assignOrderAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
        <input type="hidden" name="order_id" value={o.order_id} />
        <select name="customer_id" required style={{ flex: "1 1 220px", minWidth: 0 }} defaultValue="">
          <option value="" disabled>
            Assign to existing customer…
          </option>
          {customers.map((c) => (
            <option key={c.customer_id} value={c.customer_id}>
              {c.name || c.email || c.customer_id}
              {c.email && c.name ? ` (${c.email})` : ""}
              {c.organization_name ? ` — ${c.organization_name}` : ""}
            </option>
          ))}
        </select>
        <button className="btn btn--ghost" type="submit">Assign</button>
      </form>

      <details style={{ marginTop: "0.6rem" }}>
        <summary className="muted" style={{ cursor: "pointer", fontSize: "0.9rem" }}>
          …or create a new customer for this order
        </summary>
        <form action={createCustomerAndAssignAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
          <input type="hidden" name="order_id" value={o.order_id} />
          <input name="name" placeholder="Name (required)" required defaultValue={o.customer_name ?? ""} style={{ flex: "1 1 160px", minWidth: 0 }} />
          <input name="email" type="email" placeholder="Email" style={{ flex: "1 1 180px", minWidth: 0 }} />
          <input name="phone" placeholder="Phone" defaultValue={o.customer_phone ?? ""} style={{ flex: "1 1 130px", minWidth: 0 }} />
          <button className="btn btn--ghost" type="submit">Create & assign</button>
        </form>
      </details>
    </li>
  );
}

export default async function AdminPage() {
  const supabase = await createClient();
  const [pipelineRes, orphansRes, customersRes] = await Promise.all([
    supabase.rpc("get_admin_pipeline"),
    supabase.rpc("get_admin_orphan_orders"),
    supabase.rpc("get_admin_customers"),
  ]);
  const pipeline = (pipelineRes.data ?? []) as AdminPipelineRow[];
  const orphans = (orphansRes.data ?? []) as AdminOrphanOrder[];
  const customers = (customersRes.data ?? []) as AdminCustomer[];

  const awaiting = pipeline.filter((d) => d.customer_approval_status === "pending").length;

  return (
    <>
      <main className="wrap">
        <p className="eyebrow">Admin</p>
        <h1>Pipeline</h1>
        <p className="muted">
          Every drawer, every order — {pipeline.length} drawer{pipeline.length === 1 ? "" : "s"},{" "}
          {awaiting} awaiting customer approval, {orphans.length} unassigned order{orphans.length === 1 ? "" : "s"}.
        </p>

        {orphans.length > 0 ? (
          <section style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.2rem" }}>Unassigned orders</h2>
            <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.9rem" }}>
              Orders with no usable customer email. Map each one to a customer so it
              shows up in their portal.
            </p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {orphans.map((o) => (
                <OrphanCard key={o.order_id} o={o} customers={customers} />
              ))}
            </ul>
          </section>
        ) : null}

        <section style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.2rem" }}>All drawers</h2>
          {pipeline.length === 0 ? (
            <p className="muted">Nothing in the pipeline yet.</p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {pipeline.map((d) => (
                <PipelineRow key={d.drawer_id} d={d} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

import { createClient } from "@/lib/supabase/server";
import {
  type AdminPipelineRow,
  type AdminOrphanOrder,
  type AdminCustomer,
  STATUS_LABELS,
} from "@/lib/types";
import { markDeliveredAction } from "./actions";
import { UnassignedOrders } from "@/components/UnassignedOrders";

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
    <li className="card" style={{ marginTop: "0.7rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>
            {d.order_id ? (
              <a href={`/admin/orders/${d.order_id}`} style={{ color: "inherit" }}>
                {d.nickname || "Untitled drawer"}
              </a>
            ) : (
              d.nickname || "Untitled drawer"
            )}
          </h3>
          <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.88rem" }}>
            {d.customer_name || "No customer"}
            {d.customer_email ? ` · ${d.customer_email}` : ""}
            {d.project_name ? ` · ${d.project_name}` : ""}
          </p>
        </div>
        <ApprovalBadge status={d.customer_approval_status} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginTop: "0.7rem", alignItems: "center" }}>
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
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Pipeline</h1>
        </div>
        <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
          <span className="chip num">Drawers <strong>{pipeline.length}</strong></span>
          <span className="chip num">Awaiting approval <strong>{awaiting}</strong></span>
          <span className="chip num">Unassigned <strong>{orphans.length}</strong></span>
        </div>
      </div>

      {orphans.length > 0 ? (
        <section style={{ marginTop: "1.5rem" }}>
          <h2>Unassigned orders</h2>
          <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.9rem" }}>
            Orders with no usable customer email. Select several to assign or
            delete them together, or handle each inline.
          </p>
          <UnassignedOrders orphans={orphans} customers={customers} />
        </section>
      ) : null}

      <section style={{ marginTop: "1.5rem" }}>
        <h2>All drawers</h2>
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
  );
}

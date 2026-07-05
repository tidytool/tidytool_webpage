import { createClient } from "@/lib/supabase/server";
import {
  type AdminPipelineRow,
  type AdminOrphanOrder,
  type AdminCustomer,
} from "@/lib/types";
import { UnassignedOrders } from "@/components/UnassignedOrders";
import { PipelineList } from "@/components/PipelineList";

export const dynamic = "force-dynamic";

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
          <PipelineList pipeline={pipeline} />
        )}
      </section>
    </main>
  );
}

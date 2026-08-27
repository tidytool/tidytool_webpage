import { createClient } from "@/lib/supabase/server";
import {
  type AdminPipelineRow,
  type AdminOrphanOrder,
  type AdminCustomer,
  type StatusPipelineData,
} from "@/lib/types";
import { UnassignedOrders } from "@/components/UnassignedOrders";
import { PipelineList } from "@/components/PipelineList";
import { StatusPipeline } from "@/components/StatusPipeline";

export const dynamic = "force-dynamic";

const EMPTY_STATUS: StatusPipelineData = {
  counts: [],
  blockers: {
    drawers_awaiting_customer: 0,
    drawers_rework: 0,
    drawers_on_hold: 0,
    orders_on_hold: 0,
    orders_overridden: 0,
  },
  aging: [],
  queue: [],
  cycle: { window_days: 90, completed: 0, median_days: null },
};

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: adminData } = await supabase.rpc("is_admin");
  const isAdmin = adminData === true;
  const [statusRes, pipelineRes, orphansRes, customersRes] = await Promise.all([
    supabase.rpc("get_status_pipeline"),
    supabase.rpc("get_admin_pipeline"),
    // Unassigned-order repair is an admin tool; staff never needs the data.
    isAdmin ? supabase.rpc("get_admin_orphan_orders") : Promise.resolve({ data: null, error: null }),
    isAdmin ? supabase.rpc("get_admin_customers") : Promise.resolve({ data: null, error: null }),
  ]);
  const status = (statusRes.data ?? EMPTY_STATUS) as StatusPipelineData;
  const pipeline = (pipelineRes.data ?? []) as AdminPipelineRow[];
  const orphans = (orphansRes.data ?? []) as AdminOrphanOrder[];
  const customers = (customersRes.data ?? []) as AdminCustomer[];

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Pipeline</h1>
          <p className="muted sub">
            Live order positions, blockers, and aging — updating as tidyCAM,
            tidyCAD, and the portal move work.
          </p>
        </div>
      </div>

      {statusRes.error ? (
        <p className="banner--err" role="alert">{statusRes.error.message}</p>
      ) : (
        <StatusPipeline initial={status} />
      )}

      {isAdmin && orphans.length > 0 ? (
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
        {pipelineRes.error ? (
          <p className="banner--err" role="alert">{pipelineRes.error.message}</p>
        ) : null}
        <details className="reveal">
          <summary>All drawers ({pipeline.length})</summary>
          <div style={{ marginTop: "0.7rem" }}>
            {pipeline.length === 0 ? (
              <p className="muted">Nothing in the pipeline yet.</p>
            ) : (
              <PipelineList pipeline={pipeline} readOnly={!isAdmin} />
            )}
          </div>
        </details>
      </section>
    </main>
  );
}

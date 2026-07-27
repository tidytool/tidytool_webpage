import { createClient } from "@/lib/supabase/server";
import type { WorkQueueRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Admin → Queue: the outstanding-work view (get_work_queue) — the same
 * contract tidyCAD will consume. Rework first (a customer is actively
 * waiting), then oldest-in-stage first. Cancelled work is excluded; the
 * blocked_on column separates "our move" from "customer's move".
 */

function AgeBadge({ days }: { days: number }) {
  const cls = days > 14 ? "badge--warn" : days > 7 ? "badge--changes" : "badge--pending";
  return <span className={`badge ${cls} num`}>{days}d</span>;
}

function BlockedBadge({ row }: { row: WorkQueueRow }) {
  if (row.state === "rework") return <span className="badge badge--changes">Rework</span>;
  if (row.state === "on_hold") return <span className="badge badge--pending">On hold</span>;
  if (row.blocked_on === "customer")
    return <span className="badge badge--pending">Waiting on customer</span>;
  return <span className="badge badge--approved">Ours — up next</span>;
}

export default async function AdminQueuePage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_work_queue");

  if (error && /staff role required/i.test(error.message)) {
    return (
      <main className="wrap wrap--wide">
        <p className="banner--err" role="alert">
          Access denied — this page is for staff and admins only.
        </p>
      </main>
    );
  }

  const rows = (data ?? []) as WorkQueueRow[];
  const ours = rows.filter((r) => r.blocked_on === "us").length;
  const rework = rows.filter((r) => r.state === "rework").length;
  const customer = rows.filter((r) => r.blocked_on === "customer").length;
  const hold = rows.filter((r) => r.blocked_on === "hold").length;

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Work queue</h1>
          <p className="muted sub">
            Every outstanding drawer, most urgent first — rework at the top,
            then oldest in stage. Cancelled work is excluded.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
          <span className="chip num">Outstanding <strong>{rows.length}</strong></span>
          <span className="chip num">Our move <strong>{ours}</strong></span>
          <span className="chip num">Rework <strong>{rework}</strong></span>
          <span className="chip num">On customer <strong>{customer}</strong></span>
          {hold > 0 ? (
            <span className="chip num">On hold <strong>{hold}</strong></span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="banner--err" role="alert">{error.message}</p>
      ) : null}

      {rows.length === 0 && !error ? (
        <div className="card" style={{ marginTop: "1.25rem" }}>
          <h2 style={{ fontSize: "1.1rem" }}>Queue is clear</h2>
          <p className="muted" style={{ margin: 0 }}>
            No outstanding drawers. New scans from tidyCAM will appear here
            automatically.
          </p>
        </div>
      ) : (
        <div className="table">
          <div className="trow trow--head" style={{ gridTemplateColumns: "1.7fr 1.1fr 1.2fr 1.3fr 0.6fr" }}>
            <span>Drawer</span>
            <span>Stage</span>
            <span>Status</span>
            <span>Order</span>
            <span className="tr-right">In stage</span>
          </div>
          {rows.map((r) => (
            <a
              key={r.drawer_id}
              href={r.order_id ? `/admin/orders/${r.order_id}` : "#"}
              className="trow"
              style={{ gridTemplateColumns: "1.7fr 1.1fr 1.2fr 1.3fr 0.6fr" }}
            >
              <span>
                <span className="primary">{r.nickname ?? r.drawer_id.slice(0, 8)}</span>
                {r.state_reason ? (
                  <span className="sub" style={{ display: "block" }}>{r.state_reason}</span>
                ) : null}
              </span>
              <span className="hide-sm">
                <span className="chip">{r.stage_label}</span>
              </span>
              <span>
                <BlockedBadge row={r} />
              </span>
              <span className="hide-sm sub">
                {r.project_name ?? "—"}
                {r.customer_name ? ` · ${r.customer_name}` : ""}
              </span>
              <span className="tr-right">
                <AgeBadge days={Number(r.days_in_stage)} />
              </span>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}

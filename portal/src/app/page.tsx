import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { OrderTracker } from "@/components/OrderTracker";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";
import {
  type MyDrawer,
  type MyLabelStatus,
  type OrderTrackerData,
  STATUS_LABELS,
  formatDimensions,
  needsLabels,
} from "@/lib/types";

function ApprovalBadge({ status }: { status: MyDrawer["customer_approval_status"] }) {
  if (status === "approved")
    return <span className="badge badge--approved">Approved</span>;
  if (status === "changes_requested")
    return <span className="badge badge--changes">Changes requested</span>;
  return <span className="badge badge--pending">Awaiting approval</span>;
}

function DrawerCard({ d, label }: { d: MyDrawer; label: MyLabelStatus | undefined }) {
  const name = d.nickname || "Your TidyTool drawer";
  const dims = formatDimensions(d.dimensions);
  const stage = d.status ? STATUS_LABELS[d.status] ?? d.status : null;
  const needsAction = d.customer_approval_status === "pending";
  const askLabels = label ? needsLabels(label) : false;
  const labelsDone = !!label?.labels_submitted_at;

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "0.75rem",
          alignItems: "start",
        }}
      >
        <div>
          <h2 style={{ fontSize: "1.15rem" }}>{name}</h2>
          {d.project_name ? (
            <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>
              {d.project_name}
            </p>
          ) : null}
        </div>
        <ApprovalBadge status={d.customer_approval_status} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.9rem" }}>
        {dims ? (
          <span className="chip">
            Size <strong>{dims}</strong>
          </span>
        ) : null}
        {stage ? (
          <span className="chip">
            Stage <strong>{stage}</strong>
          </span>
        ) : null}
        {labelsDone ? <span className="chip">Labels ✓</span> : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.9rem" }}>
        {askLabels ? (
          <a
            href={`/labels/${d.id}`}
            style={{ fontWeight: 700, color: "var(--c-accent)", textDecoration: "none" }}
          >
            Name your tools →
          </a>
        ) : null}
        <a
          href={`/approve/${d.id}`}
          style={{
            fontWeight: askLabels ? 600 : 700,
            color: askLabels ? "var(--c-text-dim)" : "var(--c-accent)",
            textDecoration: "none",
          }}
        >
          {needsAction ? "Review & approve →" : "View design →"}
        </a>
      </div>
    </div>
  );
}

function DrawerGrid({
  drawers,
  labels,
}: {
  drawers: MyDrawer[];
  labels: Map<string, MyLabelStatus>;
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: "1rem",
        marginTop: "1rem",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
      }}
    >
      {drawers.map((d) => (
        <DrawerCard key={d.id} d={d} label={labels.get(d.id)} />
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  const claims = await getClaims();
  if (!claims) redirect("/login");
  const email = (claims.email as string | undefined) ?? undefined;

  const supabase = await createClient();
  const [{ data, error }, adminRes, labelRes] = await Promise.all([
    supabase.rpc("get_my_drawers"),
    supabase.rpc("is_admin"),
    // Absent until migration 20260803120000 is applied — degrades to no CTAs.
    supabase.rpc("get_my_label_status"),
  ]);
  const drawers = (data ?? []) as MyDrawer[];
  const isAdmin = adminRes.data === true;
  const labels = new Map<string, MyLabelStatus>(
    ((labelRes.error ? [] : labelRes.data ?? []) as MyLabelStatus[]).map((l) => [
      l.drawer_id,
      l,
    ]),
  );

  // The get_my_drawers RPC is staged in supabase/migrations and may not be applied yet.
  const migrationPending =
    error?.code === "PGRST202" || /function .* does not exist/i.test(error?.message ?? "");

  // Group drawers by order and fetch each order's pizza tracker. Tracker
  // failures degrade gracefully to the plain drawer grid — never block the page.
  const byOrder = new Map<string, MyDrawer[]>();
  const loose: MyDrawer[] = [];
  for (const d of drawers) {
    if (d.order_id) {
      const arr = byOrder.get(d.order_id) ?? [];
      arr.push(d);
      byOrder.set(d.order_id, arr);
    } else {
      loose.push(d);
    }
  }
  const orderIds = [...byOrder.keys()];
  const trackers = new Map<string, OrderTrackerData>();
  if (orderIds.length > 0) {
    const results = await Promise.all(
      orderIds.map((id) => supabase.rpc("get_order_tracker", { p_order_id: id })),
    );
    results.forEach((res, i) => {
      if (!res.error && res.data) trackers.set(orderIds[i], res.data as OrderTrackerData);
    });
  }

  return (
    <>
      <Header email={email} isAdmin={isAdmin} />
      <main className="wrap">
        <p className="eyebrow">Your orders</p>
        <h1>Welcome back</h1>
        <p className="muted">
          Follow each order from scan to install. Two things need you:{" "}
          <b>approve designs</b> — your go-ahead for us to cut — and{" "}
          <b>name your tools</b>, what we write on each pocket&apos;s label.
        </p>

        {migrationPending ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>Almost ready</h2>
            <p className="muted" style={{ margin: 0 }}>
              Your account is set up, but the data connection isn&apos;t live yet.
              Apply the <code>get_my_drawers</code> migration in{" "}
              <code>portal/supabase/migrations/</code> to start seeing your drawers
              here.
            </p>
          </div>
        ) : drawers.length === 0 ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>No designs found</h2>
            <p className="muted" style={{ margin: 0 }}>
              We don&apos;t have any drawers tied to <strong>{email}</strong>{" "}
              yet. Once we&apos;ve scanned and designed your organizer, it will show
              up here for approval.
            </p>
            <p className="muted" style={{ margin: "0.75rem 0 0" }}>
              Already ordered and expecting to see your designs here?{" "}
              <a
                href={`https://tally.so/r/rjW6Z5${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Let us know
              </a>{" "}
              and we&apos;ll get it sorted.
            </p>
          </div>
        ) : (
          <>
            {orderIds.map((orderId) => {
              const group = byOrder.get(orderId) ?? [];
              const tracker = trackers.get(orderId);
              const firstPending = group.find(
                (d) => d.customer_approval_status === "pending" && d.design_preview_url,
              );
              const needCount = group.filter((d) => {
                const l = labels.get(d.id);
                return l ? needsLabels(l) : false;
              }).length;
              return (
                <section key={orderId} style={{ marginTop: "1.5rem" }}>
                  {tracker ? (
                    <OrderTracker
                      t={tracker}
                      approveHref={firstPending ? `/approve/${firstPending.id}` : null}
                    />
                  ) : null}
                  {needCount > 0 ? (
                    <div className="lbl-banner">
                      🏷️{" "}
                      <span>
                        <b>
                          {needCount} drawer{needCount === 1 ? "" : "s"} need
                          {needCount === 1 ? "s" : ""} tool names
                        </b>{" "}
                        — a couple of minutes each. We fill in the labels before we
                        cut the foam.
                      </span>
                    </div>
                  ) : null}
                  <DrawerGrid drawers={group} labels={labels} />
                </section>
              );
            })}
            {loose.length > 0 ? (
              <section style={{ marginTop: "1.5rem" }}>
                {orderIds.length > 0 ? <h2>Other designs</h2> : null}
                <DrawerGrid drawers={loose} labels={labels} />
              </section>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}

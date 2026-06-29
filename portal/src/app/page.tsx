import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";
import {
  type MyDrawer,
  STATUS_LABELS,
  formatDimensions,
} from "@/lib/types";

function ApprovalBadge({ status }: { status: MyDrawer["customer_approval_status"] }) {
  if (status === "approved")
    return <span className="badge badge--approved">Approved</span>;
  if (status === "changes_requested")
    return <span className="badge badge--changes">Changes requested</span>;
  return <span className="badge badge--pending">Awaiting approval</span>;
}

function DrawerCard({ d }: { d: MyDrawer }) {
  const name = d.nickname || "Your TidyTool drawer";
  const dims = formatDimensions(d.dimensions);
  const stage = d.status ? STATUS_LABELS[d.status] ?? d.status : null;
  const needsAction = d.customer_approval_status === "pending";

  return (
    <a
      href={`/approve/${d.id}`}
      className="card"
      style={{ display: "block", textDecoration: "none", color: "inherit" }}
    >
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
      </div>

      <p style={{ margin: "0.9rem 0 0", fontWeight: 700, color: "var(--c-accent)" }}>
        {needsAction ? "Review & approve →" : "View design →"}
      </p>
    </a>
  );
}

export default async function DashboardPage() {
  const claims = await getClaims();
  if (!claims) redirect("/login");
  const email = (claims.email as string | undefined) ?? undefined;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_drawers");
  const drawers = (data ?? []) as MyDrawer[];

  // The get_my_drawers RPC is staged in supabase/migrations and may not be applied yet.
  const migrationPending =
    error?.code === "PGRST202" || /function .* does not exist/i.test(error?.message ?? "");

  return (
    <>
      <Header email={email} />
      <main className="wrap">
        <p className="eyebrow">Your designs</p>
        <h1>Welcome back</h1>
        <p className="muted">
          Review and approve your foam layouts. Approving a design is your go-ahead
          for us to cut.
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
            <h2 style={{ fontSize: "1.1rem" }}>No designs yet</h2>
            <p className="muted" style={{ margin: 0 }}>
              We don&apos;t have any drawers tied to <strong>{email}</strong>{" "}
              yet. Once we&apos;ve scanned and designed your organizer, it will show
              up here for approval.
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: "1rem",
              marginTop: "1.25rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            }}
          >
            {drawers.map((d) => (
              <DrawerCard key={d.id} d={d} />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

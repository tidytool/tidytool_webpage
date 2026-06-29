import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { ApprovalForm } from "@/components/ApprovalForm";
import { History } from "@/components/History";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";
import {
  type DrawerApproval,
  type DrawerEvent,
  formatDimensions,
} from "@/lib/types";

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const claims = await getClaims();
  const email = (claims?.email as string | undefined) ?? undefined;
  const defaultName =
    ((claims?.user_metadata as Record<string, unknown> | undefined)
      ?.full_name as string | undefined) ?? "";

  const supabase = await createClient();
  const { data: rows } = await supabase.rpc("get_drawer_approval", { p_id: id });
  const d = (Array.isArray(rows) ? rows[0] : rows) as DrawerApproval | undefined;
  if (!d) notFound();

  const { data: events } = await supabase.rpc("get_drawer_changelog", {
    p_drawer_id: id,
  });

  const name = d.nickname || "Your TidyTool design";
  const dims = formatDimensions(d.dimensions);
  const decided = d.customer_approval_status === "approved";

  return (
    <>
      <Header email={email} />
      <main className="wrap">
        <p style={{ margin: "0 0 1rem" }}>
          <a href="/" className="muted">
            ← All designs
          </a>
        </p>

        <p className="eyebrow">Design review</p>
        <h1>{name}</h1>

        {d.design_preview_url ? (
          <img
            src={d.design_preview_url}
            alt={`Proposed layout for ${name}`}
            style={{
              display: "block",
              width: "100%",
              borderRadius: "var(--radius)",
              border: "1px solid var(--c-border)",
              boxShadow: "var(--shadow)",
              marginTop: "0.5rem",
            }}
          />
        ) : (
          <div
            className="card"
            style={{ textAlign: "center", padding: "3rem 1rem", marginTop: "0.5rem" }}
          >
            <span className="muted">Design preview coming soon</span>
          </div>
        )}

        {d.dxf_url ? (
          <p style={{ textAlign: "center", margin: "0.65rem 0 0" }}>
            <a href={d.dxf_url} target="_blank" rel="noopener noreferrer" className="muted">
              Download the CAD file (DXF) ↓
            </a>
          </p>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "1rem" }}>
          {dims ? (
            <span className="chip">
              Size <strong>{dims}</strong>
            </span>
          ) : null}
          <span className="chip">
            Status{" "}
            <strong>
              {decided
                ? "Approved"
                : d.customer_approval_status === "changes_requested"
                  ? "Changes requested"
                  : "Awaiting your approval"}
            </strong>
          </span>
        </div>

        <ApprovalForm
          drawerId={d.id}
          status={d.customer_approval_status}
          approvedBy={d.approved_by}
          approvedAt={d.approved_at}
          defaultName={defaultName}
        />

        <History events={(events ?? []) as DrawerEvent[]} />
      </main>
    </>
  );
}

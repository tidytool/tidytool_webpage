import { createClient } from "@/lib/supabase/server";
import { requireAdminPage } from "@/lib/require-admin";
import { type AdminAuditRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const GRID = "minmax(160px, 1.2fr) minmax(140px, 1fr) minmax(120px, 2fr) 10rem";

export default async function AdminHistoryPage() {
  await requireAdminPage();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_admin_audit", { p_limit: 200 });
  const rows = (data ?? []) as AdminAuditRow[];

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>History</h1>
          <p className="muted sub">
            Append-only record of every admin change (latest 200). This log
            cannot be edited or deleted, by anyone.
          </p>
        </div>
      </div>
      {error ? <p className="banner--err" role="alert">{error.message}</p> : null}

      <div className="table" role="table" aria-label="History">
        <div className="trow trow--head" role="row" style={{ gridTemplateColumns: GRID }}>
          <span>Action</span>
          <span>Table</span>
          <span>Details</span>
          <span className="tr-right">When</span>
        </div>
        {rows.map((r) => (
          <div key={r.id} className="trow" style={{ gridTemplateColumns: GRID }}>
            <span className="primary">{r.action}</span>
            <span className="sub">{r.table_name}</span>
            <span className="wraptext" style={{ whiteSpace: "normal" }}>
              {r.row_id ? <span className="mono muted">{r.row_id}</span> : <span className="muted">—</span>}
              {r.before != null || r.after != null ? (
                <details className="reveal" style={{ marginTop: "0.2rem" }}>
                  <summary>before / after</summary>
                  <pre className="mono" style={{ fontSize: "0.72rem", overflowX: "auto", margin: "0.4rem 0 0", background: "var(--c-surface-2)", borderRadius: "8px", padding: "0.6rem" }}>
{JSON.stringify({ before: r.before, after: r.after }, null, 2)}
                  </pre>
                </details>
              ) : null}
            </span>
            <span className="tr-right sub num hide-sm">
              {new Date(r.created_at).toLocaleString(undefined, {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
              })}
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}

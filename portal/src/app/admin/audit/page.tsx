import { createClient } from "@/lib/supabase/server";
import { type AdminAuditRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_admin_audit", { p_limit: 200 });
  const rows = (data ?? []) as AdminAuditRow[];

  return (
    <main className="wrap">
      <p className="eyebrow">Admin</p>
      <h1>Audit log</h1>
      {error ? <p className="muted">Error: {error.message}</p> : null}
      <p className="muted">
        Append-only record of every admin change (latest 200). This log cannot be
        edited or deleted, by anyone.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {rows.map((r) => (
          <li key={r.id} className="card" style={{ marginTop: "0.6rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
              <strong>{r.action}</strong>
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                {new Date(r.created_at).toLocaleString()}
              </span>
            </div>
            <div className="muted" style={{ fontSize: "0.85rem" }}>
              {r.table_name}
              {r.row_id ? ` · ${r.row_id}` : ""}
            </div>
            {r.before != null || r.after != null ? (
              <details style={{ marginTop: "0.4rem" }}>
                <summary className="muted" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                  before / after
                </summary>
                <pre style={{ fontSize: "0.75rem", overflowX: "auto", margin: "0.4rem 0 0" }}>
{JSON.stringify({ before: r.before, after: r.after }, null, 2)}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}

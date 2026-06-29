import { type DrawerEvent } from "@/lib/types";

const EVENT_LABELS: Record<DrawerEvent["event_type"], string> = {
  design_uploaded: "Design uploaded",
  design_revised: "Design updated",
  approved: "Approved",
  changes_requested: "Changes requested",
};

export function History({ events }: { events: DrawerEvent[] }) {
  if (!events.length) return null;

  return (
    <details className="card" style={{ marginTop: "1.5rem" }}>
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>
        History ({events.length})
      </summary>
      <ul style={{ listStyle: "none", margin: "0.75rem 0 0", padding: 0 }}>
        {events.map((e, i) => {
          const label = EVENT_LABELS[e.event_type] ?? e.event_type;
          const when = e.created_at
            ? new Date(e.created_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })
            : "";
          const isDesign =
            e.event_type === "design_uploaded" || e.event_type === "design_revised";
          const rev = isDesign && e.revision != null ? ` (rev ${e.revision})` : "";
          const who = e.actor_name || (e.actor_role === "staff" ? "TidyTool" : "");
          return (
            <li
              key={i}
              style={{ padding: "0.7rem 0", borderTop: "1px solid var(--c-border)" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 700 }}>
                  {label}
                  {rev}
                </span>
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  {when}
                </span>
              </div>
              {who ? (
                <div className="muted" style={{ fontSize: "0.9rem" }}>
                  {who}
                </div>
              ) : null}
              {e.note ? (
                <p style={{ margin: "0.35rem 0 0", fontStyle: "italic" }}>
                  “{e.note}”
                </p>
              ) : null}
              {isDesign && e.preview_url ? (
                <a
                  href={e.preview_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "0.85rem" }}
                >
                  view image →
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

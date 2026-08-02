/**
 * Per-order design progress: how many drawer rows are design-complete
 * (stage sort >= DESIGNED_SORT) out of the total. Pure presentational —
 * usable from server components and inside client tables alike. The bar
 * reuses the StatusPipeline track/fill pattern with brand tokens only.
 * `designed === undefined` (RPC predates migration 20260802120000) and
 * `total === 0` both render a muted dash.
 */
export function DesignProgress({
  total,
  designed,
  compact = false,
}: {
  total: number;
  designed: number | undefined;
  compact?: boolean;
}) {
  if (designed === undefined || total <= 0) {
    return <span className="muted">—</span>;
  }
  const pct = Math.round((designed / total) * 100);
  const label = `${designed} of ${total} drawers design-complete (${pct}%), ${100 - pct}% awaiting design`;

  return (
    <span
      role="img"
      aria-label={label}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", minWidth: 0 }}
    >
      <span
        aria-hidden
        style={{
          background: "var(--c-surface-2)",
          borderRadius: 6,
          height: "0.55rem",
          overflow: "hidden",
          flex: compact ? "1 1 2.5rem" : "0 0 7rem",
          minWidth: "2rem",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${pct}%`,
            minWidth: designed > 0 ? "2px" : 0,
            height: "100%",
            borderRadius: 6,
            background: "var(--c-accent)",
          }}
        />
      </span>
      <span className="num" style={{ fontSize: "0.85rem", whiteSpace: "nowrap" }}>
        {designed}/{total}
        {compact ? null : (
          <span className="muted" style={{ fontWeight: 500 }}>
            {" "}
            designed · {100 - pct}% awaiting design
          </span>
        )}
      </span>
    </span>
  );
}

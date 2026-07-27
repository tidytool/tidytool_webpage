import type { OrderTrackerData } from "@/lib/types";

/**
 * The "pizza tracker" — one order's customer-facing progress, from
 * get_order_tracker(). Server component; no client JS.
 *
 * Semantics contract (do not soften): the stepper shows overall POSITION,
 * while blockers ("1 design awaiting your approval") and completion
 * ("12 of 20 delivered") are rendered PROMINENTLY beside it — the tracker
 * never lets "In production" read as "everything is being manufactured".
 */

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function OrderTracker({
  t,
  approveHref,
}: {
  t: OrderTrackerData;
  /** Link to the first design awaiting this customer's approval, when any. */
  approveHref?: string | null;
}) {
  const awaiting = t.blockers?.awaiting_approval ?? 0;
  const total = t.completion?.total ?? 0;
  const delivered = t.completion?.delivered ?? 0;
  const scheduled = fmtDate(t.delivery_scheduled_at);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "1.15rem", margin: 0 }}>
            {t.project_name ?? "Your order"}
          </h2>
          {total > 1 ? (
            <p className="muted num" style={{ margin: "0.15rem 0 0", fontSize: "0.88rem" }}>
              {delivered} of {total} drawers delivered
            </p>
          ) : null}
        </div>
        {t.exception ? (
          <span className="badge badge--warn">
            {t.exception.state === "cancelled" ? "Cancelled" : "On hold"}
          </span>
        ) : scheduled && t.current_step === 6 ? (
          <span className="badge badge--approved num">Delivery {scheduled}</span>
        ) : null}
      </div>

      {t.exception?.state === "cancelled" ? (
        <p className="banner--err" role="status">
          This order was cancelled. Its history is preserved below — reach out
          if that&apos;s unexpected.
        </p>
      ) : (
        <div className="tracker" role="list" aria-label="Order progress">
          {t.steps.map((s) => (
            <div
              key={s.step}
              role="listitem"
              className={`tracker__step${s.state === "done" ? " tracker__step--done" : s.state === "current" ? " tracker__step--current" : ""}`}
              aria-current={s.state === "current" ? "step" : undefined}
            >
              <span className="tracker__dot" aria-hidden />
              <div className="tracker__label">
                {s.step === 6 && scheduled ? "Ready — delivery scheduled" : s.label}
              </div>
              {s.state !== "todo" && s.entered_at ? (
                <div className="tracker__date num">
                  {s.inferred ? "~" : ""}
                  {fmtDate(s.entered_at)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* Blockers — the customer's own next action gets the loudest treatment */}
      {awaiting > 0 && !t.exception ? (
        <p
          role="status"
          style={{
            margin: "1rem 0 0",
            padding: "0.6rem 0.9rem",
            background: "var(--c-danger-bg)",
            border: "1px solid #eac2bc",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.92rem",
            fontWeight: 600,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.8rem",
            flexWrap: "wrap",
          }}
        >
          <span>
            {awaiting === 1
              ? "1 design is waiting on your approval — we can't cut it until you sign off."
              : `${awaiting} designs are waiting on your approval — we can't cut them until you sign off.`}
          </span>
          {approveHref ? (
            <a className="btn btn--primary btn--sm" href={approveHref}>
              Review &amp; approve
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

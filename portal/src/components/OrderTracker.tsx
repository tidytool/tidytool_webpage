import type { OrderTrackerData } from "@/lib/types";

/**
 * The order stepper — one order's customer-facing progress, from
 * get_order_tracker(). Server component; no client JS.
 *
 * 2026-08 UX pass: this is now JUST the stepper (plus the cancelled banner).
 * The order name, counts, and status badges render in the dashboard's group
 * header, and the approval blocker banner is gone — the customer approval
 * step was removed from the portal (label submission is the go-ahead), so
 * step 4 renders as "Tool labels" regardless of the server-side label.
 *
 * Semantics contract (do not soften): the stepper shows overall POSITION —
 * per-drawer reality lives in the drawer list beside it. Never let
 * "In production" here read as "everything is being manufactured".
 */

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Customer-facing overrides for server step labels. */
function stepLabel(step: number, label: string, scheduled: string | null): string {
  if (step === 4) return "Tool labels";
  if (step === 6 && scheduled) return "Ready — delivery scheduled";
  return label;
}

export function OrderTracker({
  t,
  labelsIncluded = true,
}: {
  t: OrderTrackerData;
  /** False when no drawer in the order has engraved labels (tier) — step 4
   *  renders grayed as "not included" so nobody waits on it. */
  labelsIncluded?: boolean;
}) {
  const scheduled = fmtDate(t.delivery_scheduled_at);

  if (t.exception?.state === "cancelled") {
    return (
      <p className="banner--err" role="status">
        This order was cancelled. Its history is preserved below — reach out
        if that&apos;s unexpected.
      </p>
    );
  }

  return (
    <div className="tracker" role="list" aria-label="Order progress">
      {t.steps.map((s) => {
        const na = s.step === 4 && !labelsIncluded;
        return (
          <div
            key={s.step}
            role="listitem"
            className={`tracker__step${na ? " tracker__step--na" : s.state === "done" ? " tracker__step--done" : s.state === "current" ? " tracker__step--current" : ""}`}
            aria-current={!na && s.state === "current" ? "step" : undefined}
          >
            <span className="tracker__dot" aria-hidden />
            <div className="tracker__label">{stepLabel(s.step, s.label, scheduled)}</div>
            {na ? (
              <div className="tracker__date">not included</div>
            ) : s.state !== "todo" && s.entered_at ? (
              <div className="tracker__date num">
                {s.inferred ? "~" : ""}
                {fmtDate(s.entered_at)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

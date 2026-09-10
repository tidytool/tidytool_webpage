"use client";

/**
 * Order-level hold / cancel / reactivate controls (admin only). Renders the
 * current state as a badge and the state changes behind small modals so a
 * reason is always captured — the database refuses hold/cancel without one.
 * Cancelling offers a cascade to the order's non-cancelled drawers, because
 * the status backbone keeps order and drawer state independent: an
 * order-only cancel would leave its drawers active in the pipeline.
 */
import { Modal } from "@/components/Modal";
import { ConfirmButton } from "@/components/ConfirmButton";
import { setOrderStateAction } from "@/app/admin/actions";

export function OrderStateControls({
  orderId,
  state,
  stateReason,
  cancellableDrawerIds,
}: {
  orderId: string;
  state: string;
  stateReason: string | null;
  /** Drawers not already cancelled — offered for the cancel cascade. */
  cancellableDrawerIds: string[];
}) {
  if (state === "cancelled" || state === "on_hold") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span className="badge badge--warn" title={stateReason ?? undefined}>
          {state === "cancelled" ? "Cancelled" : "On hold"}
          {stateReason ? ` — ${stateReason}` : ""}
        </span>
        <form action={setOrderStateAction}>
          <input type="hidden" name="order_id" value={orderId} />
          <input type="hidden" name="state" value="active" />
          <ConfirmButton
            className="btn btn--ghost"
            message={
              state === "cancelled"
                ? "Reactivate this order? Drawers cancelled with it stay cancelled — reactivate those individually under Organize."
                : "Take this order off hold?"
            }
          >
            Reactivate
          </ConfirmButton>
        </form>
      </div>
    );
  }

  return (
    <>
      <Modal label="Hold" title="Put order on hold">
        <form action={setOrderStateAction} style={{ display: "grid", gap: "0.7rem" }}>
          <input type="hidden" name="order_id" value={orderId} />
          <input type="hidden" name="state" value="on_hold" />
          <label className="ctrl">
            <span>Reason (shown in history)</span>
            <input name="reason" required placeholder="e.g. Waiting on customer PO" />
          </label>
          <button className="btn btn--primary" type="submit">
            Put on hold
          </button>
        </form>
      </Modal>

      <Modal label="Cancel order…" title="Cancel order" triggerClassName="btn btn--danger">
        <form action={setOrderStateAction} style={{ display: "grid", gap: "0.7rem" }}>
          <input type="hidden" name="order_id" value={orderId} />
          <input type="hidden" name="state" value="cancelled" />
          <input type="hidden" name="drawer_ids" value={cancellableDrawerIds.join(",")} />
          <label className="ctrl">
            <span>Reason (shown in history)</span>
            <input name="reason" required placeholder="e.g. Customer did not proceed" />
          </label>
          {cancellableDrawerIds.length > 0 ? (
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.9rem" }}>
              <input type="checkbox" name="cascade" defaultChecked />
              Also cancel its {cancellableDrawerIds.length} drawer
              {cancellableDrawerIds.length === 1 ? "" : "s"} (recommended — otherwise they stay
              active in the pipeline)
            </label>
          ) : null}
          <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
            Cancelling keeps all history and can be reversed with Reactivate. To erase the order
            entirely, use Delete instead.
          </p>
          <button className="btn btn--danger" type="submit">
            Cancel order
          </button>
        </form>
      </Modal>
    </>
  );
}

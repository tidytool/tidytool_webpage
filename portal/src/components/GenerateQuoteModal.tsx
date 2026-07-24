"use client";

/**
 * The revenue action, elevated to the top of the order page and moved into a
 * focused overlay (redesign brief: "Generate quote should be a button near the
 * top that pulls up a pop-up"). It shows exactly what will be priced, pre-fills
 * the order's saved round-trip miles, and tucks the internal-only cost inputs —
 * which move margin, not the customer price — behind a disclosure so the common
 * case is one click. It closes itself on a successful generate and shows pricing
 * errors inline instead of bouncing to a page-level banner.
 */
import { useActionState, useEffect, useRef } from "react";
import { quoteFormAction, type QuoteFormState } from "@/app/admin/quote-actions";

export function GenerateQuoteModal({
  orderId,
  drawerCount,
  physicalCount,
  defaultMiles,
  hasSite,
}: {
  orderId: string;
  drawerCount: number;
  physicalCount: number;
  defaultMiles: number | null;
  hasSite: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState<QuoteFormState, FormData>(quoteFormAction, {});

  // useActionState returns a fresh state object per dispatch, so depending on the
  // whole object re-fires this on every submit — closing the dialog each success.
  useEffect(() => {
    if (state.ok) ref.current?.close();
  }, [state]);

  const noDrawers = drawerCount === 0;

  return (
    <>
      <button type="button" className="btn btn--primary" onClick={() => ref.current?.showModal()}>
        Generate quote
      </button>

      <dialog
        ref={ref}
        className="modal"
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <div className="modal__panel">
          <div className="modal__head">
            <h2 style={{ margin: 0 }}>Generate quote</h2>
            <button
              type="button"
              className="modal__x"
              aria-label="Close"
              onClick={() => ref.current?.close()}
            >
              ✕
            </button>
          </div>

          <div className="modal__body">
            <p className="muted" style={{ fontSize: "0.9rem", marginTop: 0 }}>
              Pricing <strong>{drawerCount}</strong> drawer{drawerCount === 1 ? "" : "s"}
              {physicalCount !== drawerCount ? (
                <>
                  {" "}
                  · <strong>×{physicalCount}</strong> physical copies
                </>
              ) : null}{" "}
              from their scanned dimensions using the active rate card ($20/sqft, $40 min per physical
              drawer, $250 order min). Foam scales per physical copy; design is charged once.
            </p>

            {noDrawers ? (
              <p className="banner--err" role="alert" style={{ marginTop: 0 }}>
                This order has no drawers to price yet. Add a scan first.
              </p>
            ) : null}

            {state.error ? (
              <p className="banner--err" role="alert">
                {state.error}
              </p>
            ) : null}

            <form
              action={formAction}
              style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}
            >
              <input type="hidden" name="order_id" value={orderId} />

              <label className="ctrl" style={{ gridColumn: "1 / -1" }}>
                <span>
                  Round-trip miles
                  {defaultMiles != null ? " (saved on order)" : hasSite ? "" : " — no site address set yet"}
                </span>
                <input
                  name="round_trip_miles"
                  inputMode="decimal"
                  required
                  placeholder="e.g. 30"
                  defaultValue={defaultMiles ?? ""}
                />
              </label>

              <details className="reveal" style={{ gridColumn: "1 / -1" }}>
                <summary>Cost assumptions — affect margin only, not the customer price</summary>
                <div
                  style={{
                    display: "grid",
                    gap: "0.7rem",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                    marginTop: "0.6rem",
                  }}
                >
                  <label className="ctrl">
                    <span>Drive hours / trip</span>
                    <input name="drive_hours_per_trip" inputMode="decimal" required defaultValue="0.75" />
                  </label>
                  <label className="ctrl">
                    <span>Install hours</span>
                    <input name="install_hours" inputMode="decimal" required defaultValue="1" />
                  </label>
                  <label className="ctrl">
                    <span>Trips</span>
                    <input name="trips" type="number" min="1" step="1" defaultValue="2" />
                  </label>
                </div>
              </details>

              <label className="ctrl" style={{ gridColumn: "1 / -1" }}>
                <span>Notes (optional)</span>
                <input name="notes" placeholder="Internal notes for this quote" />
              </label>

              <div
                style={{
                  gridColumn: "1 / -1",
                  display: "flex",
                  gap: "0.6rem",
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button type="button" className="btn btn--ghost" onClick={() => ref.current?.close()}>
                  Cancel
                </button>
                <button type="submit" className="btn btn--primary" disabled={pending || noDrawers}>
                  {pending ? "Generating…" : "Generate quote"}
                </button>
              </div>
            </form>

            {!hasSite ? (
              <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.8rem" }}>
                Tip: set the site address under <strong>Edit details</strong> to auto-fill travel miles and
                keep them consistent across quotes.
              </p>
            ) : null}
          </div>
        </div>
      </dialog>
    </>
  );
}

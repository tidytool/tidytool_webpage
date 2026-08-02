"use client";

/**
 * The revenue action, elevated to the top of the order page and moved into a
 * focused overlay. Now a two-step calculator (Sam, 2026-08-01):
 *
 *   1. Inputs — miles/hours as before, PLUS every pricing knob (tier $/sqft,
 *      shipping base + per-sqft, travel $/mi, design base, minimums), each
 *      pre-filled from the ACTIVE rate card. Untouched knobs record no
 *      override; changed ones are stored on the quote (config_overrides) and
 *      the saved quote shows a "Custom rates" badge.
 *   2. Preview — a full no-save pricing pass renders the exact line items,
 *      total, internal cost and margin the Save would persist. Tweak → preview
 *      → save, so every number is inspectable before it exists.
 */
import { useActionState, useEffect, useRef } from "react";
import {
  quoteFormAction,
  quotePreviewAction,
  type QuoteFormState,
  type QuotePreviewState,
} from "@/app/admin/quote-actions";
import { formatCents } from "@/lib/types";

/** Knob defaults from the active pricing config, pre-formatted as dollar strings. */
export type RateDefaults = {
  essential: string;
  professional: string;
  premium: string;
  design_base: string;
  travel_per_mile: string;
  ship_base: string;
  ship_per_sqft: string;
  drawer_min: string;
  order_min: string;
};

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

export function GenerateQuoteModal({
  orderId,
  drawerCount,
  physicalCount,
  defaultMiles,
  hasSite,
  rates,
}: {
  orderId: string;
  drawerCount: number;
  physicalCount: number;
  defaultMiles: number | null;
  hasSite: boolean;
  rates: RateDefaults;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState<QuoteFormState, FormData>(quoteFormAction, {});
  const [previewState, previewAction, previewPending] = useActionState<QuotePreviewState, FormData>(
    quotePreviewAction,
    {},
  );

  // useActionState returns a fresh state object per dispatch, so depending on the
  // whole object re-fires this on every submit — closing the dialog each success.
  useEffect(() => {
    if (state.ok) ref.current?.close();
  }, [state]);

  const noDrawers = drawerCount === 0;
  const p = previewState.preview;

  const knob = (name: keyof RateDefaults, label: string) => (
    <label className="ctrl">
      <span>{label}</span>
      <input name={name === "essential" || name === "professional" || name === "premium" ? `rate_${name}` : name}
        inputMode="decimal" required defaultValue={rates[name]} />
    </label>
  );

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
              from their scanned dimensions. Foam = tier rate × sqft per physical copy; measurement =
              scan-visit travel; delivery = estimated shipping. Rates below default from the active rate
              card — change any of them for this quote only, then <strong>Preview</strong> before saving.
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
            {previewState.error ? (
              <p className="banner--err" role="alert">
                {previewState.error}
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
                <summary>Pricing rates — $ values, defaults from the active rate card</summary>
                <div
                  style={{
                    display: "grid",
                    gap: "0.7rem",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                    marginTop: "0.6rem",
                  }}
                >
                  {knob("essential", "Essential $/sqft")}
                  {knob("professional", "Professional $/sqft")}
                  {knob("premium", "Premium $/sqft")}
                  {knob("ship_base", "Shipping base $")}
                  {knob("ship_per_sqft", "Shipping $/sqft")}
                  {knob("travel_per_mile", "Travel $/mi")}
                  {knob("design_base", "Design base $")}
                  {knob("drawer_min", "Min $/drawer")}
                  {knob("order_min", "Order minimum $")}
                </div>
                <p className="muted" style={{ fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
                  Changed values apply to THIS quote only and are recorded on it — the saved quote shows a
                  &ldquo;Custom rates&rdquo; badge. The rate card itself doesn&rsquo;t change.
                </p>
              </details>

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
                    <input name="install_hours" inputMode="decimal" required defaultValue="0" />
                  </label>
                  <label className="ctrl">
                    <span>Trips</span>
                    <input name="trips" type="number" min="1" step="1" defaultValue="1" />
                  </label>
                </div>
              </details>

              <label className="ctrl" style={{ gridColumn: "1 / -1" }}>
                <span>Notes (optional)</span>
                <input name="notes" placeholder="Internal notes for this quote" />
              </label>

              {p ? (
                <div style={{ gridColumn: "1 / -1" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                    <tbody>
                      {p.lines.map((l, i) => (
                        <tr key={i} style={{ borderTop: "1px solid var(--c-border)" }}>
                          <td style={{ padding: "0.35rem 0.5rem 0.35rem 0" }}>
                            {l.description}
                            {l.qty != null && l.qty > 1 && l.unit_price_cents != null ? (
                              <span className="muted"> — {l.qty} × {formatCents(l.unit_price_cents)}</span>
                            ) : null}
                          </td>
                          <td className="num" style={{ padding: "0.35rem 0", textAlign: "right", whiteSpace: "nowrap" }}>
                            {formatCents(l.amount_cents)}
                          </td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: "2px solid var(--c-border)" }}>
                        <td style={{ padding: "0.4rem 0.5rem 0.4rem 0", textAlign: "right" }}>
                          <strong>Total</strong>
                        </td>
                        <td className="num" style={{ padding: "0.4rem 0", textAlign: "right" }}>
                          <strong>{formatCents(p.total_cents)}</strong>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                    <span className="chip">
                      Est. cost <strong className="num">{formatCents(p.estimated_cost_cents)}</strong>
                    </span>
                    {p.below_target ? (
                      <span className="badge badge--warn">Margin {pct(p.gross_margin)} — below target</span>
                    ) : (
                      <span className="chip">
                        Margin <strong className="num">{pct(p.gross_margin)}</strong>
                      </span>
                    )}
                    {p.override_count > 0 ? <span className="badge badge--warn">Custom rates ({p.override_count})</span> : null}
                  </div>
                  {p.unpriced.length > 0 ? (
                    <p className="banner--err" role="alert" style={{ marginTop: "0.5rem" }}>
                      Unpriced drawers: {p.unpriced.join("; ")}
                    </p>
                  ) : null}
                  {p.warnings.length > 0 ? (
                    <ul className="muted" style={{ fontSize: "0.82rem", margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
                      {p.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
                    Preview only — nothing is saved until Generate. Changing any value above? Preview again.
                  </p>
                </div>
              ) : null}

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
                <button
                  type="submit"
                  formAction={previewAction}
                  className="btn btn--ghost"
                  disabled={previewPending || noDrawers}
                >
                  {previewPending ? "Calculating…" : p ? "Re-preview" : "Preview"}
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

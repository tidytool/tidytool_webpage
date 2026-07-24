import { createQuoteAction, setQuoteStatusAction } from "@/app/admin/quote-actions";
import { formatCents, type AdminQuote } from "@/lib/types";
import { CustomerBreakdown } from "@/components/CustomerBreakdown";

/**
 * Quotes card on the admin order page: generate a quote from the drawers'
 * scanned dimensions + per-job inputs, review line items, track status.
 *
 * The "Internal" box (cost estimate, gross margin) is for staff eyes only —
 * if a customer-facing quote view is ever built, it renders ONLY the lines,
 * subtotal, and total.
 */

const NEXT_STATUSES: Record<string, string[]> = {
  draft: ["sent", "void"],
  sent: ["accepted", "declined", "expired", "void"],
  accepted: ["void"],
  declined: ["void"],
  expired: ["sent", "void"],
  void: [],
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  void: "Void",
};

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

/** Drawer→copies as the quote was priced (from its product-line meta). */
function quotedCopies(quote: AdminQuote): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of quote.lines) {
    if (l.kind === "product" && l.drawer_id) {
      const c = typeof l.meta?.copies === "number" ? l.meta.copies : 1;
      m.set(l.drawer_id, c);
    }
  }
  return m;
}

/**
 * A quote is stale if the order's physical structure (which drawers, and how
 * many copies of each) changed after it was priced. Compares the quote's
 * product lines against the order's current drawer/box/copy layout. Ignores
 * mileage/hours changes — those are re-entered per quote, not "structure".
 */
function isStale(quote: AdminQuote, current: { id: string; copies: number }[]): boolean {
  const priced = quotedCopies(quote);
  const now = new Map(current.map((d) => [d.id, d.copies]));
  if (priced.size !== now.size) return true;
  for (const [id, copies] of now) {
    if (!priced.has(id) || priced.get(id) !== copies) return true;
  }
  return false;
}

export function QuotesSection({
  orderId,
  quotes,
  currentDrawerCopies,
}: {
  orderId: string;
  quotes: AdminQuote[];
  currentDrawerCopies: { id: string; copies: number }[];
}) {
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2>
        Quotes{" "}
        <span className="muted num" style={{ fontWeight: 500 }}>
          ({quotes.length})
        </span>
      </h2>

      <div className="card" style={{ marginTop: "0.75rem" }}>
        <h3 style={{ margin: 0 }}>Generate quote</h3>
        <p className="muted" style={{ fontSize: "0.85rem", margin: "0.2rem 0 0.9rem" }}>
          Prices every drawer from its scanned dimensions using the active rate card ($20/sqft,
          $40 min per physical drawer, $250 order min), foam ×&nbsp;physical copies. Services:
          $100 design once + $1.25/mi travel on each visit. <strong>Round-trip miles affects the
          customer price</strong> (the travel lines); drive/install hours and trips affect only
          the internal cost estimate &amp; margin.
        </p>
        <form
          action={createQuoteAction}
          style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}
        >
          <input type="hidden" name="order_id" value={orderId} />
          <label className="ctrl">
            <span>Round-trip miles</span>
            <input name="round_trip_miles" inputMode="decimal" required placeholder="e.g. 30" />
          </label>
          <label className="ctrl">
            <span>Drive hours per trip</span>
            <input name="drive_hours_per_trip" inputMode="decimal" required placeholder="e.g. 0.75" />
          </label>
          <label className="ctrl">
            <span>Install hours</span>
            <input name="install_hours" inputMode="decimal" required placeholder="e.g. 1" />
          </label>
          <label className="ctrl">
            <span>Trips</span>
            <input name="trips" type="number" min="1" step="1" defaultValue="2" />
          </label>
          <label className="ctrl" style={{ gridColumn: "1 / -1" }}>
            <span>Notes (optional)</span>
            <input name="notes" placeholder="Internal notes for this quote" />
          </label>
          <div>
            <button className="btn btn--primary" type="submit">
              Generate quote
            </button>
          </div>
        </form>
      </div>

      {quotes.map((q) => {
        const stale = isStale(q, currentDrawerCopies);
        return (
        <div key={q.id} className="card" style={{ marginTop: "1rem", borderColor: stale ? "var(--c-warn, #c80)" : undefined }}>
          {stale ? (
            <p className="banner--warn" role="status" style={{ marginTop: 0 }}>
              ⚠ The order&rsquo;s boxes or drawer copies changed after this quote was priced.
              Regenerate for current pricing.
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <strong>{formatCents(q.total_cents)}</strong>
            <span className="chip">
              Status <strong>{STATUS_LABEL[q.status] ?? q.status}</strong>
            </span>
            {q.below_target ? (
              <span className="badge badge--warn">
                Margin {pct(q.gross_margin)} — below {pct(q.margin_target)} target
              </span>
            ) : (
              <span className="chip">
                Margin <strong className="num">{pct(q.gross_margin)}</strong>
              </span>
            )}
            <span className="muted" style={{ fontSize: "0.85rem", marginLeft: "auto" }}>
              {new Date(q.created_at).toLocaleDateString()}
              {q.valid_until ? ` · valid until ${new Date(q.valid_until).toLocaleDateString()}` : ""}
            </span>
          </div>

          <table style={{ width: "100%", marginTop: "0.8rem", borderCollapse: "collapse", fontSize: "0.92rem" }}>
            <tbody>
              {q.lines.map((l) => (
                <tr key={l.position} style={{ borderTop: "1px solid var(--c-border)" }}>
                  <td style={{ padding: "0.45rem 0.5rem 0.45rem 0" }}>
                    {l.description}
                    {l.unit === "copies"
                      ? l.qty != null && l.qty > 1 && l.unit_price_cents != null
                        ? <span className="muted">{" "}— {l.qty} × {formatCents(l.unit_price_cents)}</span>
                        : null
                      : l.qty != null && l.unit
                        ? (
                          <span className="muted">
                            {" "}
                            — {l.qty.toFixed(2)} {l.unit}
                            {l.unit_price_cents != null ? ` × ${formatCents(l.unit_price_cents)}` : ""}
                          </span>
                        )
                        : null}
                  </td>
                  <td className="num" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {l.included ? <span className="muted">Included</span> : formatCents(l.amount_cents)}
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: "2px solid var(--c-border)" }}>
                <td style={{ padding: "0.45rem 0.5rem 0.45rem 0" }}>
                  <strong>Total</strong>
                </td>
                <td className="num" style={{ textAlign: "right" }}>
                  <strong>{formatCents(q.total_cents)}</strong>
                </td>
              </tr>
            </tbody>
          </table>

          <CustomerBreakdown quote={q} />

          <details className="reveal" style={{ marginTop: "0.6rem" }}>
            <summary>Internal — cost estimate &amp; margin (never customer-facing)</summary>
            <div style={{ fontSize: "0.88rem", marginTop: "0.5rem", display: "grid", gap: "0.15rem" }}>
              <span>
                Mileage {formatCents(q.cost_breakdown.mileage_cents)} · Driving{" "}
                {formatCents(q.cost_breakdown.driving_labor_cents)} · Scanning{" "}
                {formatCents(q.cost_breakdown.scanning_labor_cents)} · Install{" "}
                {formatCents(q.cost_breakdown.install_labor_cents)}
              </span>
              <span>
                Estimated cost <strong>{formatCents(q.estimated_cost_cents)}</strong> · Gross profit{" "}
                <strong>{formatCents(q.gross_profit_cents)}</strong> · Margin{" "}
                <strong>{pct(q.gross_margin)}</strong> (target {pct(q.margin_target)})
              </span>
              <span className="muted">
                Assumes {q.cost_breakdown.assumptions.trips} trip(s),{" "}
                {q.cost_breakdown.assumptions.round_trip_miles} round-trip mi,{" "}
                {q.cost_breakdown.assumptions.scanning_hours} h scanning for{" "}
                {q.cost_breakdown.assumptions.total_area_sqft} sqft.
              </span>
            </div>
          </details>

          {q.warnings.length > 0 ? (
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              ⚠ {q.warnings.join(" · ")}
            </p>
          ) : null}
          {q.unpriced_drawers.length > 0 ? (
            <p className="banner--err" style={{ marginTop: "0.5rem" }}>
              {q.unpriced_drawers.length} drawer(s) could not be priced:{" "}
              {q.unpriced_drawers.map((d) => `${d.nickname ?? d.id.slice(0, 8)} (${d.reason})`).join(", ")}
            </p>
          ) : null}
          {q.notes ? (
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {q.notes}
            </p>
          ) : null}

          {NEXT_STATUSES[q.status]?.length ? (
            <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.7rem", flexWrap: "wrap" }}>
              {NEXT_STATUSES[q.status].map((s) => (
                <form key={s} action={setQuoteStatusAction}>
                  <input type="hidden" name="quote_id" value={q.id} />
                  <input type="hidden" name="order_id" value={orderId} />
                  <input type="hidden" name="status" value={s} />
                  <button className="btn btn--ghost" type="submit">
                    {s === "sent" ? "Mark sent" : `Mark ${STATUS_LABEL[s]?.toLowerCase() ?? s}`}
                  </button>
                </form>
              ))}
            </div>
          ) : null}
        </div>
        );
      })}
    </section>
  );
}

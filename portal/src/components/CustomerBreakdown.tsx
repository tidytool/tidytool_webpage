"use client";

/**
 * Customer-facing breakdown on the admin order page — the QuickBooks-ready view
 * of a quote. Renders ONLY the customer lines (no cost/margin) and a
 * "Copy for QuickBooks" button that puts a tab-separated block on the clipboard
 * for pasting into a spreadsheet or a QB estimate. Projection logic lives in
 * @/lib/pricing/quickbooks (pure + tested); this component is just the surface.
 */
import { useState } from "react";
import { formatCents, type AdminQuote } from "@/lib/types";
import { toQuickBooksRows, toQuickBooksTsv } from "@/lib/pricing/quickbooks";

export function CustomerBreakdown({ quote }: { quote: AdminQuote }) {
  const [copied, setCopied] = useState(false);
  const rows = toQuickBooksRows(quote);
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);

  async function copy() {
    try {
      await navigator.clipboard.writeText(toQuickBooksTsv(quote));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="reveal" style={{ marginTop: "0.6rem" }}>
      <summary>Customer breakdown (QuickBooks-ready)</summary>
      <div style={{ marginTop: "0.5rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--c-muted, #667)" }}>
              <th style={{ padding: "0.3rem 0.5rem 0.3rem 0", fontWeight: 600 }}>Product/Service</th>
              <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600 }}>Description</th>
              <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, textAlign: "right" }}>Qty</th>
              <th style={{ padding: "0.3rem 0.5rem", fontWeight: 600, textAlign: "right" }}>Rate</th>
              <th style={{ padding: "0.3rem 0 0.3rem 0.5rem", fontWeight: 600, textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--c-border)" }}>
                <td style={{ padding: "0.4rem 0.5rem 0.4rem 0", whiteSpace: "nowrap" }}>{r.item}</td>
                <td style={{ padding: "0.4rem 0.5rem" }} className="muted">{r.description}</td>
                <td className="num" style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{r.qty}</td>
                <td className="num" style={{ padding: "0.4rem 0.5rem", textAlign: "right" }}>{formatCents(r.rate_cents)}</td>
                <td className="num" style={{ padding: "0.4rem 0 0.4rem 0.5rem", textAlign: "right" }}>{formatCents(r.amount_cents)}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid var(--c-border)" }}>
              <td colSpan={4} style={{ padding: "0.4rem 0.5rem 0.4rem 0", textAlign: "right" }}>
                <strong>Total</strong>
              </td>
              <td className="num" style={{ padding: "0.4rem 0 0.4rem 0.5rem", textAlign: "right" }}>
                <strong>{formatCents(total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginTop: "0.7rem", flexWrap: "wrap" }}>
          <button className="btn btn--ghost" type="button" onClick={copy}>
            {copied ? "Copied ✓" : "Copy for QuickBooks"}
          </button>
          <span className="muted" style={{ fontSize: "0.83rem" }}>
            Tab-separated — paste into a spreadsheet or a QuickBooks estimate. Tax is applied in QuickBooks.
          </span>
        </div>
      </div>
    </details>
  );
}

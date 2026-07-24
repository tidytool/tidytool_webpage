/**
 * Customer-facing breakdown → QuickBooks estimate projection.
 *
 * Takes a stored quote and returns ONLY the customer lines (no cost/margin,
 * ever) shaped for a QuickBooks Online estimate. Two deliberate choices, both
 * so QB's Qty × Rate = Amount always holds:
 *
 *  1. Every line is Qty 1, Rate = Amount = the line's cents. Drawers are NOT
 *     sent as `sqft × $20` — the per-drawer $40 minimum and sqft rounding would
 *     make Qty×Rate disagree with Amount. The sqft math lives in the
 *     Description instead ("2.03 sqft @ $20.00/sqft" / "order minimum").
 *  2. "Included" service lines are real $0.00 rows so the value shows on the
 *     estimate without changing the total.
 *
 * Tax is intentionally absent: QuickBooks applies it per customer (many
 * TidyTool buyers — schools, public colleges, gov — are exempt). This projection
 * is always pre-tax, and its Amount column sums to quote.total_cents exactly.
 */
import type { AdminQuote, AdminQuoteLine } from "../types";

export type QbRow = {
  /** QuickBooks Product/Service item name. */
  item: string;
  description: string;
  /** Always 1 — the amount is carried on Rate, so Qty×Rate=Amount holds. */
  qty: number;
  rate_cents: number;
  amount_cents: number;
};

/** Stable QuickBooks Product/Service item per line kind. Create these once in QB. */
const ITEM_BY_KIND: Record<AdminQuoteLine["kind"], string> = {
  measurement_design: "On-site Measurement & Design",
  product: "Custom Foam Tool Organizer",
  upgrade: "Optional Upgrade",
  delivery_install: "Delivery, Installation & Test Fit",
  min_order_adjustment: "Minimum Order Adjustment",
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Drawer description: label + dims (from the line) + sqft@rate or "order minimum". */
function productDescription(line: AdminQuoteLine): string {
  const base = line.description.replace(/^Custom Foam Tool Organizer\s*[—-]\s*/, "");
  if (line.meta?.drawer_minimum_applied === true) return `${base} · order minimum`;
  const area = num(line.meta?.area_sqft);
  if (area != null && line.unit_price_cents != null) {
    return `${base} · ${area.toFixed(2)} sqft @ $${dollars(line.unit_price_cents)}/sqft`;
  }
  return base;
}

function descriptionFor(line: AdminQuoteLine): string {
  if (line.included) return "Included with order";
  switch (line.kind) {
    case "product":
      return productDescription(line);
    case "upgrade":
      return line.description.replace(/^Optional Upgrade\s*[—-]\s*/, "");
    case "min_order_adjustment": {
      const min = num(line.meta?.order_minimum_cents);
      return min != null ? `Brings the order up to the $${dollars(min)} minimum` : "Small-order minimum";
    }
    default:
      return line.description;
  }
}

/** Customer lines as QuickBooks-estimate rows. Amount column sums to quote.total_cents. */
export function toQuickBooksRows(quote: AdminQuote): QbRow[] {
  return quote.lines.map((l) => {
    const amount = l.included ? 0 : l.amount_cents;
    return {
      item: ITEM_BY_KIND[l.kind] ?? l.description,
      description: descriptionFor(l),
      qty: 1,
      rate_cents: amount,
      amount_cents: amount,
    };
  });
}

/**
 * Tab-separated block for pasting into a spreadsheet or a QuickBooks estimate.
 * Header row + one row per line + a Total row. Rate/Amount are plain decimals
 * (no "$") so they land cleanly in numeric cells.
 */
export function toQuickBooksTsv(quote: AdminQuote): string {
  const rows = toQuickBooksRows(quote);
  const header = ["Product/Service", "Description", "Qty", "Rate", "Amount"].join("\t");
  const body = rows.map((r) =>
    [r.item, r.description, String(r.qty), dollars(r.rate_cents), dollars(r.amount_cents)].join("\t"),
  );
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  body.push(["", "Total", "", "", dollars(total)].join("\t"));
  return [header, ...body].join("\n");
}

/**
 * Customer-facing breakdown → QuickBooks estimate projection.
 *
 * Takes a stored quote and returns ONLY the customer lines (no cost/margin,
 * ever) shaped for a QuickBooks Online estimate. Two deliberate choices, both
 * so QBO's own Amount = Qty × Rate recompute can never disagree with us:
 *
 *  1. PRODUCT lines carry the copy count as Qty and the per-copy price as Rate
 *     (both integer cents, so Qty × Rate = Amount is exact). Drawers are NOT
 *     sent as `sqft × $20` — the per-drawer $40 minimum and sqft rounding would
 *     make Qty×Rate disagree with Amount. The sqft math lives in the
 *     Description instead ("2.03 sqft @ $20.00/sqft" / "order minimum").
 *  2. Every OTHER line is flat: Qty 1, Rate = Amount = the line's cents. This
 *     must stay true for future per-sqft upgrades too — a fractional Qty would
 *     let QBO's recompute drift from our stored amount.
 *
 * Totals are pre-tax: QuickBooks applies tax per customer (many TidyTool
 * buyers — schools, public colleges, gov — are exempt, and the exemption lives
 * on the QBO customer record). Each row DOES carry a `taxable` flag — the
 * line-level Tax checkbox / future TaxCodeRef (TAX vs NON) — because line
 * taxability is a property of what's sold, while the exemption is a property
 * of who buys it. The Amount column sums to quote.total_cents exactly.
 */
import { TIER_LABEL, isTier } from "./config";
import type { AdminQuote, AdminQuoteLine } from "../types";

export type QbRow = {
  /** QuickBooks Product/Service item name. */
  item: string;
  description: string;
  /** Copies for product lines; 1 for everything else (Qty×Rate=Amount exact). */
  qty: number;
  rate_cents: number;
  amount_cents: number;
  /** QBO line Tax checkbox / TaxCodeRef: true → TAX, false → NON. */
  taxable: boolean;
};

/**
 * QuickBooks Product/Service item per line kind, matched to Sam's REAL QBO
 * catalog (decision 2026-07-30): reuse "Scanning & Design" and
 * "Delivery & Installation" as they exist; product lines map to a per-tier
 * item ("Organizer Foam - Essential / - Professional / - Premium" — rename the
 * old "- Engraved" to "- Professional" in QBO); "Minimum Order Adjustment" is
 * new. These names are now the frozen contract: the future API sync resolves
 * each to its QBO ItemRef Id, and renaming either side breaks the mapping.
 */
const ITEM_BY_KIND: Record<Exclude<AdminQuoteLine["kind"], "product">, string> = {
  measurement_design: "Scanning & Design",
  upgrade: "Optional Upgrade",
  delivery_install: "Delivery & Installation",
  min_order_adjustment: "Minimum Order Adjustment",
};

/** Per-tier QBO item for product lines. Tier read from line meta; default essential. */
function productItem(line: AdminQuoteLine): string {
  const tier = isTier(line.meta?.tier) ? line.meta.tier : "essential";
  return `Organizer Foam - ${TIER_LABEL[tier]}`;
}

/**
 * Line-level taxability (QBO TaxCodeRef TAX vs NON).
 *
 * PLACEHOLDER SPLIT — CONFIRM WITH THE ACCOUNTANT before the API sync ships:
 * tangible product (foam) and its minimum-order shortfall are marked taxable;
 * design/travel/install services are not. Sales-tax treatment of services and
 * delivery varies by state. Customer-level exemptions (schools, gov) are NOT
 * handled here — they live on the QBO customer record and override per buyer.
 */
const TAXABLE_BY_KIND: Record<AdminQuoteLine["kind"], boolean> = {
  measurement_design: false,
  product: true,
  upgrade: true,
  delivery_install: false,
  min_order_adjustment: true,
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Drawer description built from meta (never parsed from the display string):
 * "{label} — {dims} · {sqft} sqft @ ${rate}/sqft" or "· order minimum". The copy
 * count lives in the QB Qty column, so it is NOT repeated here.
 */
function productDescription(line: AdminQuoteLine): string {
  const label = typeof line.meta?.label === "string" ? line.meta.label : "Drawer";
  const dims = typeof line.meta?.dims_text === "string" ? ` — ${line.meta.dims_text}` : "";
  if (line.meta?.drawer_minimum_applied === true) return `${label}${dims} · order minimum`;
  const area = num(line.meta?.area_sqft);
  const rate = num(line.meta?.sqft_rate_cents);
  if (area != null && rate != null) {
    return `${label}${dims} · ${area.toFixed(2)} sqft @ $${dollars(rate)}/sqft`;
  }
  return `${label}${dims}`;
}

function descriptionFor(line: AdminQuoteLine): string {
  switch (line.kind) {
    case "product":
      return productDescription(line);
    case "measurement_design": {
      const base = num(line.meta?.base_cents);
      const travel = num(line.meta?.travel_cents);
      const miles = num(line.meta?.round_trip_miles);
      const parts: string[] = [];
      if (base != null && base > 0) parts.push(`$${dollars(base)} design`);
      if (travel != null && travel > 0) parts.push(`${miles ?? 0} mi round-trip travel ($${dollars(travel)})`);
      return parts.join(" + ") || "On-site measurement & design";
    }
    case "delivery_install": {
      // v4 shipping meta first; legacy travel meta as fallback.
      const shipSqft = num(line.meta?.physical_area_sqft);
      const shipBase = num(line.meta?.shipping_base_cents);
      const shipRate = num(line.meta?.shipping_cents_per_sqft);
      if (shipBase != null && shipRate != null) {
        return shipSqft != null && shipSqft > 0
          ? `Estimated shipping — ${shipSqft} sqft foam ($${dollars(shipBase)} + $${dollars(shipRate)}/sqft)`
          : `Estimated shipping ($${dollars(shipBase)} base)`;
      }
      const miles = num(line.meta?.round_trip_miles);
      const travel = num(line.meta?.travel_cents);
      return travel != null && travel > 0 ? `${miles ?? 0} mi round-trip travel` : "Delivery & installation";
    }
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

/**
 * Customer lines as QuickBooks-estimate rows. Amount column sums to
 * quote.total_cents. Product lines carry the copy count as Qty and the per-copy
 * price as Rate (Qty × Rate = Amount holds); all other lines are flat Qty 1.
 */
export function toQuickBooksRows(quote: AdminQuote): QbRow[] {
  return quote.lines.map((l) => {
    if (l.kind === "product") {
      const qty = l.qty ?? 1;
      const rate = l.unit_price_cents ?? l.amount_cents;
      return {
        item: productItem(l),
        description: descriptionFor(l),
        qty,
        rate_cents: rate,
        amount_cents: l.amount_cents,
        taxable: TAXABLE_BY_KIND.product,
      };
    }
    return {
      item: ITEM_BY_KIND[l.kind] ?? l.description,
      description: descriptionFor(l),
      qty: 1,
      rate_cents: l.amount_cents,
      amount_cents: l.amount_cents,
      taxable: TAXABLE_BY_KIND[l.kind] ?? false,
    };
  });
}

/**
 * Tab-separated keying reference for a QuickBooks estimate. (QBO's estimate
 * grid does not accept a pasted TSV block — this is read side-by-side while
 * keying, or pasted into a spreadsheet.) Header row + one row per line + a
 * Total row to reconcile against QBO's total after entry. Rate/Amount are
 * plain decimals (no "$") so they land cleanly in numeric cells; Tax is the
 * QBO line Tax checkbox (Y/N).
 */
export function toQuickBooksTsv(quote: AdminQuote): string {
  const rows = toQuickBooksRows(quote);
  const header = ["Product/Service", "Description", "Qty", "Rate", "Amount", "Tax"].join("\t");
  const body = rows.map((r) =>
    [r.item, r.description, String(r.qty), dollars(r.rate_cents), dollars(r.amount_cents), r.taxable ? "Y" : "N"].join(
      "\t",
    ),
  );
  const total = rows.reduce((s, r) => s + r.amount_cents, 0);
  body.push(["", "Total", "", "", dollars(total), ""].join("\t"));
  return [header, ...body].join("\n");
}

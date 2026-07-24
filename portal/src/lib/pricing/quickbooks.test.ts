/**
 * QuickBooks projection tests. Builds a real quote with the engine, wraps it in
 * the stored (AdminQuote) shape, and checks the customer breakdown is
 * QB-faithful: reconciles to the total, drawers are flat Qty-1 lines, minimums
 * read correctly, and no internal cost/margin leaks.
 *
 * Run:  npm run test:pricing
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeQuote, type QuoteDrawerInput, type QuoteInputs } from "./engine";
import { DEFAULT_PRICING_CONFIG } from "./config";
import { toQuickBooksRows, toQuickBooksTsv } from "./quickbooks";
import type { AdminQuote } from "../types";

const INPUTS: QuoteInputs = { round_trip_miles: 40, drive_hours_per_trip: 0.75, install_hours: 1.5 };

/** Wrap a ComputedQuote in the AdminQuote shape get_quotes_for_order returns. */
function asAdminQuote(drawers: QuoteDrawerInput[]): AdminQuote {
  const q = computeQuote(drawers, INPUTS, DEFAULT_PRICING_CONFIG);
  return {
    id: "q1",
    created_at: "2026-07-24T00:00:00Z",
    status: "draft",
    subtotal_cents: q.subtotal_cents,
    total_cents: q.total_cents,
    estimated_cost_cents: q.estimated_cost_cents,
    gross_profit_cents: q.gross_profit_cents,
    gross_margin: q.gross_margin,
    margin_target: q.margin_target,
    below_target: q.below_target,
    warnings: q.warnings,
    unpriced_drawers: q.unpriced_drawers,
    valid_until: null,
    notes: null,
    cost_breakdown: q.cost_breakdown as AdminQuote["cost_breakdown"],
    lines: q.lines.map((l) => ({
      position: l.position,
      kind: l.kind,
      description: l.description,
      drawer_id: l.drawer_id,
      qty: l.qty,
      unit: l.unit,
      unit_price_cents: l.unit_price_cents,
      amount_cents: l.amount_cents,
      included: l.included,
      meta: l.meta,
    })),
  };
}

const SAMPLE: QuoteDrawerInput[] = [
  { id: "1", nickname: "Hand Tools", dimensions: { unit: "feetDecimal", width: 1.2172, height: 1.6699, thickness: "oneHalf" } },
  { id: "2", nickname: "Large Drawer", dimensions: { length: 25.5, width: 49, thickness: 0.5, units: "in" } },
  { id: "3", nickname: "Small tray", dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" } },
];

test("QB rows reconcile: amount column sums to the quote total", () => {
  const quote = asAdminQuote(SAMPLE);
  const rows = toQuickBooksRows(quote);
  const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
  assert.equal(sum, quote.total_cents);
});

test("every QB row is flat Qty 1 with Rate == Amount", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  for (const r of rows) {
    assert.equal(r.qty, 1);
    assert.equal(r.rate_cents, r.amount_cents);
  }
});

test("non-floored drawer shows sqft @ rate; floored drawer shows 'order minimum'", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  const hand = rows.find((r) => r.description.startsWith("Hand Tools"))!;
  const tray = rows.find((r) => r.description.startsWith("Small tray"))!;
  assert.match(hand.description, /sqft @ \$20\.00\/sqft/);
  assert.equal(hand.item, "Custom Foam Tool Organizer");
  assert.match(tray.description, /order minimum/);
  assert.equal(tray.amount_cents, 4000);
});

test("included service lines are real $0.00 rows", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  const measure = rows.find((r) => r.item === "On-site Measurement & Design")!;
  const install = rows.find((r) => r.item === "Delivery, Installation & Test Fit")!;
  assert.equal(measure.amount_cents, 0);
  assert.equal(measure.description, "Included with order");
  assert.equal(install.amount_cents, 0);
});

test("min-order adjustment reads as bringing the order to the minimum", () => {
  // one tiny drawer → order-minimum line appears
  const quote = asAdminQuote([{ id: "s", nickname: "tiny", dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" } }]);
  const rows = toQuickBooksRows(quote);
  const adj = rows.find((r) => r.item === "Minimum Order Adjustment")!;
  assert.match(adj.description, /\$250\.00 minimum/);
  const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
  assert.equal(sum, quote.total_cents); // still reconciles
});

test("TSV: header + one row per line + Total row, no cost/margin anywhere", () => {
  const quote = asAdminQuote(SAMPLE);
  const tsv = toQuickBooksTsv(quote);
  const lines = tsv.split("\n");
  assert.equal(lines[0], "Product/Service\tDescription\tQty\tRate\tAmount");
  assert.equal(lines.length, 1 + quote.lines.length + 1); // header + lines + total
  assert.ok(lines[lines.length - 1].startsWith("\tTotal\t"));
  assert.equal(lines[lines.length - 1].endsWith("254.19"), true);
  // internal figures must never appear in a customer breakdown
  assert.equal(tsv.includes("margin"), false);
  assert.equal(tsv.includes(String(quote.estimated_cost_cents)), false);
});

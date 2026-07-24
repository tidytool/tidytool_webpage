/**
 * QuickBooks projection tests (Stage 2: copies + travel-priced services).
 * Run:  npm run test:pricing
 *
 * Checks the customer breakdown is QB-faithful: reconciles to the total, product
 * lines carry copies as Qty with per-copy Rate (Qty×Rate=Amount), priced service
 * rows are real, and no internal cost/margin leaks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeQuote, type QuoteDrawerInput, type QuoteInputs } from "./engine";
import { DEFAULT_PRICING_CONFIG } from "./config";
import { toQuickBooksRows, toQuickBooksTsv } from "./quickbooks";
import type { AdminQuote } from "../types";

const INPUTS: QuoteInputs = { round_trip_miles: 120, drive_hours_per_trip: 2, install_hours: 1.5 };

function asAdminQuote(drawers: QuoteDrawerInput[]): AdminQuote {
  const q = computeQuote(drawers, INPUTS, DEFAULT_PRICING_CONFIG);
  return {
    id: "q1", created_at: "2026-07-24T00:00:00Z", status: "draft",
    subtotal_cents: q.subtotal_cents, total_cents: q.total_cents,
    estimated_cost_cents: q.estimated_cost_cents, gross_profit_cents: q.gross_profit_cents,
    gross_margin: q.gross_margin, margin_target: q.margin_target, below_target: q.below_target,
    warnings: q.warnings, unpriced_drawers: q.unpriced_drawers, valid_until: null, notes: null,
    cost_breakdown: q.cost_breakdown as AdminQuote["cost_breakdown"],
    lines: q.lines.map((l) => ({
      position: l.position, kind: l.kind, description: l.description, drawer_id: l.drawer_id,
      qty: l.qty, unit: l.unit, unit_price_cents: l.unit_price_cents, amount_cents: l.amount_cents,
      included: l.included, meta: l.meta,
    })),
  };
}

const SAMPLE: QuoteDrawerInput[] = [
  { id: "1", nickname: "Socket Drawer", dimensions: { length: 27.01, width: 16.1, thickness: 0.5, units: "in" }, copies: 2 },
  { id: "2", nickname: "Small tray", dimensions: { width: 12, length: 12, thickness: 0.5, units: "in" } },
];

test("QB amount column sums to the quote total", () => {
  const quote = asAdminQuote(SAMPLE);
  const rows = toQuickBooksRows(quote);
  assert.equal(rows.reduce((s, r) => s + r.amount_cents, 0), quote.total_cents);
});

test("product line: Qty = copies, Rate = per-copy, Qty×Rate = Amount", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  const socket = rows.find((r) => r.description.startsWith("Socket Drawer"))!;
  assert.equal(socket.item, "Custom Foam Tool Organizer");
  assert.equal(socket.qty, 2);
  assert.equal(socket.qty * socket.rate_cents, socket.amount_cents);
  assert.match(socket.description, /sqft @ \$20\.00\/sqft/);
  assert.equal(/×\s*\d+\s*$/.test(socket.description), false); // no trailing "× N" — copies live in Qty
});

test("floored drawer reads 'order minimum'", () => {
  const tray = toQuickBooksRows(asAdminQuote(SAMPLE)).find((r) => r.description.startsWith("Small tray"))!;
  assert.match(tray.description, /order minimum/);
  assert.equal(tray.rate_cents, 4000);
});

test("service lines are real priced rows (not 'Included')", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  const m = rows.find((r) => r.item === "On-site Measurement & Design")!;
  const d = rows.find((r) => r.item === "Delivery, Installation & Test Fit")!;
  assert.equal(m.amount_cents, 10000 + 120 * 125); // $100 + travel
  assert.match(m.description, /design/);
  assert.equal(d.amount_cents, 120 * 125);
  assert.match(d.description, /travel/);
});

test("TSV: header + row per line + Total; no cost/margin leaks", () => {
  const quote = asAdminQuote(SAMPLE);
  const tsv = toQuickBooksTsv(quote);
  const rows = tsv.split("\n");
  assert.equal(rows[0], "Product/Service\tDescription\tQty\tRate\tAmount");
  assert.equal(rows.length, 1 + quote.lines.length + 1);
  assert.ok(rows[rows.length - 1].startsWith("\tTotal\t"));
  assert.equal(tsv.includes("margin"), false);
  assert.equal(tsv.includes(String(quote.estimated_cost_cents)), false);
  assert.equal(tsv.includes(String(quote.gross_profit_cents)), false);
});

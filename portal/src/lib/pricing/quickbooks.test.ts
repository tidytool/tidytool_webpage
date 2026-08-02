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
    quote_number: 42, qb_estimate_id: null, qb_synced_at: null,
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
  assert.equal(socket.item, "Organizer Foam - Essential"); // untagged fixture drawers default to essential
  assert.equal(socket.qty, 2);
  assert.equal(socket.qty * socket.rate_cents, socket.amount_cents);
  assert.match(socket.description, /sqft @ \$20\.00\/sqft/);
  assert.equal(/×\s*\d+\s*$/.test(socket.description), false); // no trailing "× N" — copies live in Qty
});

test("small drawer prices purely by sqft (no floor since v4)", () => {
  const tray = toQuickBooksRows(asAdminQuote(SAMPLE)).find((r) => r.description.startsWith("Small tray"))!;
  assert.match(tray.description, /1(\.00)? sqft @ \$20\.00\/sqft/);
  assert.equal(tray.description.includes("order minimum"), false);
  assert.equal(tray.rate_cents, 2000);
});

test("service lines: scan travel + shipping estimate (v4)", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  const m = rows.find((r) => r.item === "Scanning & Design")!;
  const d = rows.find((r) => r.item === "Delivery & Installation")!;
  assert.equal(m.amount_cents, 120 * 125); // travel only — no design base
  assert.match(m.description, /travel/);
  assert.equal(m.description.includes("design"), false); // $0 base never rendered
  // socket 3.0199 sqft × 2 copies + tray 1 sqft = 7.04 sqft → $15 + $1.50/sqft
  assert.equal(d.amount_cents, 1500 + 1056);
  assert.match(d.description, /Estimated shipping — 7\.04 sqft foam/);
});

test("TSV: header + row per line + Total; no cost/margin leaks", () => {
  const quote = asAdminQuote(SAMPLE);
  const tsv = toQuickBooksTsv(quote);
  const rows = tsv.split("\n");
  assert.equal(rows[0], "Product/Service\tDescription\tQty\tRate\tAmount\tTax");
  assert.equal(rows.length, 1 + quote.lines.length + 1);
  assert.ok(rows[rows.length - 1].startsWith("\tTotal\t"));
  assert.equal(tsv.includes("margin"), false);
  assert.equal(tsv.includes(String(quote.estimated_cost_cents)), false);
  assert.equal(tsv.includes(String(quote.gross_profit_cents)), false);
});

test("taxability: product/minimum taxable, services non-taxable (accountant placeholder)", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  for (const r of rows) {
    const isService =
      r.item === "Scanning & Design" || r.item === "Delivery & Installation";
    assert.equal(r.taxable, !isService, `${r.item} taxable flag`);
  }
  // TSV mirrors the flag as a Y/N Tax column, one value per line row.
  const tsv = toQuickBooksTsv(asAdminQuote(SAMPLE));
  const body = tsv.split("\n").slice(1, -1);
  for (const [i, line] of body.entries()) {
    assert.match(line.split("\t")[5], /^[YN]$/, `row ${i} Tax cell`);
  }
});

test("every line is Qty×Rate=Amount exact (QBO recompute can never drift)", () => {
  const rows = toQuickBooksRows(asAdminQuote(SAMPLE));
  for (const r of rows) {
    assert.equal(r.qty * r.rate_cents, r.amount_cents, `${r.item}: ${r.qty} × ${r.rate_cents}`);
    assert.ok(Number.isInteger(r.qty), `${r.item}: Qty must be an integer, got ${r.qty}`);
  }
});

test("tiered drawers map to per-tier QBO items with per-tier rates in the description", () => {
  const mixed: QuoteDrawerInput[] = [
    { id: "e", nickname: "E", dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" }, tier: "essential" },
    { id: "p", nickname: "P", dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" }, tier: "professional" },
    { id: "m", nickname: "M", dimensions: { width: 24, length: 24, thickness: 0.5, units: "in" }, tier: "premium" },
  ];
  const rows = toQuickBooksRows(asAdminQuote(mixed));
  const byNick = (n: string) => rows.find((r) => r.description.startsWith(n))!;
  assert.equal(byNick("E").item, "Organizer Foam - Essential");
  assert.equal(byNick("P").item, "Organizer Foam - Professional");
  assert.equal(byNick("M").item, "Organizer Foam - Premium");
  assert.match(byNick("P").description, /@ \$24\.00\/sqft/);
  assert.match(byNick("M").description, /@ \$28\.00\/sqft/);
  assert.equal(byNick("P").rate_cents, 4 * 2400);
  assert.equal(byNick("M").rate_cents, 4 * 2800);
  // all three tiers taxable (product kind)
  for (const n of ["E", "P", "M"]) assert.equal(byNick(n).taxable, true);
});

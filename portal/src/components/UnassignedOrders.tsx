"use client";

import { useState, useTransition } from "react";
import type { AdminOrphanOrder, AdminCustomer } from "@/lib/types";
import { bulkAssignOrders, bulkDeleteOrders } from "@/app/admin/actions";
import {
  assignOrderAction,
  createCustomerAndAssignAction,
} from "@/app/admin/actions";

function fmtDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/**
 * Unassigned ("orphan") orders with multi-select: check several, then assign
 * them to one customer or delete them together. Single-order assign/create
 * still works inline on each row.
 */
export function UnassignedOrders({
  orphans,
  customers,
}: {
  orphans: AdminOrphanOrder[];
  customers: AdminCustomer[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCustomer, setBulkCustomer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allSelected = orphans.length > 0 && selected.size === orphans.length;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(orphans.map((o) => o.order_id)));

  const runBulkAssign = () => {
    setError(null);
    startTransition(async () => {
      const res = await bulkAssignOrders(Array.from(selected), bulkCustomer);
      if (res.error) setError(res.error);
      else setSelected(new Set());
    });
  };

  const runBulkDelete = () => {
    const n = selected.size;
    if (!window.confirm(
      `Permanently delete ${n} order${n === 1 ? "" : "s"} and their drawers?\n` +
      `A full copy is kept in the audit log.`,
    )) return;
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteOrders(Array.from(selected));
      if (res.error) setError(res.error);
      else setSelected(new Set());
    });
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.9rem" }}>
        <input
          type="checkbox"
          id="orphans-all"
          checked={allSelected}
          onChange={toggleAll}
          aria-label="Select all unassigned orders"
        />
        <label htmlFor="orphans-all" className="muted" style={{ fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" }}>
          Select all ({orphans.length})
        </label>
      </div>

      {selected.size > 0 ? (
        <div className="bulkbar">
          <span className="num">{selected.size} selected</span>
          <select
            value={bulkCustomer}
            onChange={(e) => setBulkCustomer(e.target.value)}
            aria-label="Customer to assign selected orders to"
            style={{ flex: "1 1 200px", minWidth: 0 }}
          >
            <option value="">Assign selection to…</option>
            {customers.map((c) => (
              <option key={c.customer_id} value={c.customer_id}>
                {c.name || c.email || c.customer_id}
                {c.organization_name ? ` — ${c.organization_name}` : ""}
              </option>
            ))}
          </select>
          <button className="btn btn--sm btn--primary" disabled={pending || !bulkCustomer} onClick={runBulkAssign}>
            Assign
          </button>
          <button className="btn btn--sm btn--danger" disabled={pending} onClick={runBulkDelete}>
            Delete
          </button>
        </div>
      ) : null}
      {error ? <p className="banner--err" role="alert">{error}</p> : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {orphans.map((o) => {
          const price = o.total_price != null ? `$${(o.total_price / 100).toFixed(2)}` : null;
          return (
            <li key={o.order_id} className="card" style={{ marginTop: "0.7rem", display: "flex", gap: "0.9rem" }}>
              <input
                type="checkbox"
                checked={selected.has(o.order_id)}
                onChange={() => toggle(o.order_id)}
                aria-label={`Select order from ${o.customer_name || "unknown customer"}`}
                style={{ marginTop: "0.25rem", flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ margin: 0 }}>
                  {o.customer_name || "Unknown customer"}
                  {o.project_name ? <span className="muted" style={{ fontWeight: 500 }}> — {o.project_name}</span> : ""}
                </h3>
                <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.85rem" }}>
                  {fmtDate(o.created_at)}
                  {o.drawer_count != null ? ` · ${o.drawer_count} drawer${o.drawer_count === 1 ? "" : "s"}` : ""}
                  {price ? ` · ${price}` : ""}
                  {o.customer_email ? ` · ${o.customer_email}` : " · no email on order"}
                </p>

                <form action={assignOrderAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.8rem", flexWrap: "wrap" }}>
                  <input type="hidden" name="order_id" value={o.order_id} />
                  <select name="customer_id" required style={{ flex: "1 1 220px", minWidth: 0 }} defaultValue="">
                    <option value="" disabled>Assign to existing customer…</option>
                    {customers.map((c) => (
                      <option key={c.customer_id} value={c.customer_id}>
                        {c.name || c.email || c.customer_id}
                        {c.email && c.name ? ` (${c.email})` : ""}
                        {c.organization_name ? ` — ${c.organization_name}` : ""}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn--ghost" type="submit">Assign</button>
                </form>

                <details className="reveal" style={{ marginTop: "0.6rem" }}>
                  <summary>Create a new customer for this order</summary>
                  <form action={createCustomerAndAssignAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
                    <input type="hidden" name="order_id" value={o.order_id} />
                    <input name="name" placeholder="Name (required)" required defaultValue={o.customer_name ?? ""} style={{ flex: "1 1 160px", minWidth: 0 }} />
                    <input name="email" type="email" placeholder="Email" style={{ flex: "1 1 180px", minWidth: 0 }} />
                    <input name="phone" placeholder="Phone" defaultValue={o.customer_phone ?? ""} style={{ flex: "1 1 130px", minWidth: 0 }} />
                    <button className="btn btn--ghost" type="submit">Create & assign</button>
                  </form>
                </details>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

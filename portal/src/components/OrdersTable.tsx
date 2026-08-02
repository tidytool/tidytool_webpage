"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminOrderRow, AdminCustomer } from "@/lib/types";
import { formatCents } from "@/lib/types";
import { bulkAssignOrders, bulkDeleteOrders } from "@/app/admin/actions";
import { DesignProgress } from "@/components/DesignProgress";

const GRID = "1.4rem minmax(200px, 2fr) minmax(140px, 1.2fr) 5rem minmax(110px, 1fr) 6.5rem 7.5rem";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Orders table with row navigation + multi-select bulk assign/delete. */
export function OrdersTable({
  orders,
  customers,
}: {
  orders: AdminOrderRow[];
  customers: AdminCustomer[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCustomer, setBulkCustomer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allSelected = orders.length > 0 && selected.size === orders.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(orders.map((o) => o.order_id)));

  const runBulkAssign = () => {
    setError(null);
    startTransition(async () => {
      const res = await bulkAssignOrders(Array.from(selected), bulkCustomer);
      if (res.error) setError(res.error);
      else {
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  const runBulkDelete = () => {
    const n = selected.size;
    if (!window.confirm(
      `Permanently delete ${n} order${n === 1 ? "" : "s"} and their drawers?\n` +
      `A full copy is kept in History.`,
    )) return;
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteOrders(Array.from(selected));
      if (res.error) setError(res.error);
      else {
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  return (
    <>
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

      <div className="table" role="table" aria-label="Orders">
        <div className="trow trow--head" role="row" style={{ gridTemplateColumns: GRID }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            aria-label="Select all orders"
          />
          <span>Customer / project</span>
          <span>Organization</span>
          <span className="tr-right">Drawers</span>
          <span className="hide-sm">Design</span>
          <span className="tr-right">Total</span>
          <span className="tr-right">Created</span>
        </div>
        {orders.length === 0 ? (
          <div className="trow muted" style={{ gridTemplateColumns: "1fr" }}>
            No orders match. <a href="/admin/orders">Clear filters</a>
          </div>
        ) : (
          orders.map((o) => (
            <div
              key={o.order_id}
              className="trow trow--click"
              role="row"
              style={{ gridTemplateColumns: GRID }}
              onClick={() => router.push(`/admin/orders/${o.order_id}`)}
            >
              <input
                type="checkbox"
                checked={selected.has(o.order_id)}
                onChange={() => toggle(o.order_id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select order from ${o.customer_name || "unknown"}`}
              />
              <span>
                <span className="primary">{o.customer_name || "Unknown"}</span>
                {o.project_name ? <span className="muted"> — {o.project_name}</span> : null}
                <br />
                <span className="sub">
                  {o.customer_email || "no email"}
                  {!o.customer_id ? <> · <span className="badge badge--warn">Unassigned</span></> : null}
                </span>
              </span>
              <span className="sub hide-sm">{o.organization_name ?? "—"}</span>
              <span className="tr-right num hide-sm">{o.drawer_rows}</span>
              <span className="hide-sm">
                <DesignProgress compact total={o.drawer_rows} designed={o.drawers_designed} />
              </span>
              <span className="tr-right num">{formatCents(o.total_price) ?? "—"}</span>
              <span className="tr-right sub num hide-sm">{fmtDate(o.created_at)}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

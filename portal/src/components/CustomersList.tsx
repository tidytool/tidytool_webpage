"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminCustomer, AdminOrganization } from "@/lib/types";
import {
  updateCustomerAction,
  setCustomerOrgAction,
  mergeCustomersAction,
  deleteCustomerAction,
  bulkDeleteCustomers,
} from "@/app/admin/actions";
import { ConfirmButton } from "@/components/ConfirmButton";

/** Customers with multi-select bulk delete. Deleting unlinks the customer's
 *  orders (they reappear as "unassigned"). Customers with portal logins are
 *  protected — their checkboxes and delete buttons are disabled. */
export function CustomersList({
  customers,
  organizations,
}: {
  customers: AdminCustomer[];
  organizations: AdminOrganization[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const deletable = customers.filter((c) => !c.has_login);
  const allSelected = deletable.length > 0 && selected.size === deletable.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(deletable.map((c) => c.customer_id)));

  const runBulkDelete = () => {
    const picked = customers.filter((c) => selected.has(c.customer_id));
    const orderCount = picked.reduce((s, c) => s + c.order_count, 0);
    const typed = window.prompt(
      `Delete ${picked.length} customer${picked.length === 1 ? "" : "s"}?\n` +
      `${orderCount} linked order${orderCount === 1 ? "" : "s"} will become unassigned (not deleted).\n\n` +
      `Type DELETE to confirm:`,
    );
    if (typed !== "DELETE") return;
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteCustomers(Array.from(selected));
      if (res.error) setError(res.error);
      else {
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.9rem" }}>
        <input
          type="checkbox"
          id="customers-all"
          checked={allSelected}
          onChange={toggleAll}
          aria-label="Select all customers without portal logins"
        />
        <label htmlFor="customers-all" className="muted" style={{ fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" }}>
          Select all without logins ({deletable.length})
        </label>
      </div>

      {selected.size > 0 ? (
        <div className="bulkbar">
          <span className="num">{selected.size} selected</span>
          <button className="btn btn--sm btn--danger" disabled={pending} onClick={runBulkDelete}>
            Delete
          </button>
        </div>
      ) : null}
      {error ? <p className="banner--err" role="alert">{error}</p> : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {customers.map((c) => (
          <li key={c.customer_id} className="card" style={{ marginTop: "0.7rem", display: "flex", gap: "0.9rem" }}>
            <input
              type="checkbox"
              checked={selected.has(c.customer_id)}
              onChange={() => toggle(c.customer_id)}
              disabled={c.has_login}
              title={c.has_login ? "Has a portal login — protected" : undefined}
              aria-label={`Select ${c.name || c.email || "unnamed customer"}`}
              style={{ marginTop: "0.25rem", flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", alignItems: "center" }}>
                  <span className="chip num">Orders <strong>{c.order_count}</strong></span>
                  {c.has_login ? <span className="badge badge--approved">Portal login</span> : null}
                  {c.organization_name ? <span className="chip">{c.organization_name}</span> : null}
                </div>
                <form action={deleteCustomerAction}>
                  <input type="hidden" name="customer_id" value={c.customer_id} />
                  {!c.has_login ? (
                    <ConfirmButton
                      message={
                        `Delete customer "${c.name || c.email || "unnamed"}"?` +
                        (c.order_count > 0
                          ? `\nTheir ${c.order_count} order${c.order_count === 1 ? "" : "s"} will become unassigned (not deleted).`
                          : "")
                      }
                      className="btn btn--sm btn--danger"
                    >
                      Delete
                    </ConfirmButton>
                  ) : (
                    <button className="btn btn--sm btn--danger" disabled title="Has a portal login — protected" type="button">
                      Delete
                    </button>
                  )}
                </form>
              </div>

              <form action={updateCustomerAction} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginTop: "0.8rem" }}>
                <input type="hidden" name="customer_id" value={c.customer_id} />
                <label className="ctrl" style={{ flex: "1 1 150px" }}>
                  <span>Name</span>
                  <input name="name" defaultValue={c.name ?? ""} />
                </label>
                <label className="ctrl" style={{ flex: "1 1 190px" }}>
                  <span>Email</span>
                  <input name="email" type="email" defaultValue={c.email ?? ""} />
                </label>
                <label className="ctrl" style={{ flex: "1 1 130px" }}>
                  <span>Phone</span>
                  <input name="phone" defaultValue={c.phone ?? ""} />
                </label>
                <button className="btn btn--ghost" type="submit">Save</button>
              </form>

              <div style={{ display: "flex", gap: "0.9rem", flexWrap: "wrap", marginTop: "0.7rem", alignItems: "center" }}>
                <form action={setCustomerOrgAction} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  <input type="hidden" name="customer_id" value={c.customer_id} />
                  <select name="organization_id" defaultValue={c.organization_id ?? ""} aria-label="Organization">
                    <option value="">No organization</option>
                    {organizations.map((g) => (
                      <option key={g.organization_id} value={g.organization_id}>{g.name}</option>
                    ))}
                  </select>
                  <button className="btn btn--ghost btn--sm" type="submit">Set org</button>
                </form>

                <details className="reveal">
                  <summary>Merge a duplicate into this record</summary>
                  <form action={mergeCustomersAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                    <input type="hidden" name="keep_id" value={c.customer_id} />
                    <select name="merge_id" required defaultValue="">
                      <option value="" disabled>Duplicate to absorb…</option>
                      {customers
                        .filter((x) => x.customer_id !== c.customer_id)
                        .map((x) => (
                          <option key={x.customer_id} value={x.customer_id}>
                            {x.name || x.email || x.customer_id}
                            {x.email && x.name ? ` (${x.email})` : ""}
                          </option>
                        ))}
                    </select>
                    <button className="btn btn--ghost btn--sm" type="submit">Merge</button>
                  </form>
                </details>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

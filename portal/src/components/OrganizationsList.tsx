"use client";

import { useState, useTransition } from "react";
import type { AdminOrganization } from "@/lib/types";
import {
  bulkDeleteOrganizations,
  renameOrgAction,
  deleteOrgAction,
} from "@/app/admin/actions";
import { ConfirmButton } from "@/components/ConfirmButton";

/** Organizations with multi-select bulk delete. Only empty orgs (no customers,
 *  no orders) are selectable/deletable — the DB enforces the same guard. */
export function OrganizationsList({ organizations }: { organizations: AdminOrganization[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isEmpty = (g: AdminOrganization) => g.customer_count === 0 && g.order_count === 0;
  const deletable = organizations.filter(isEmpty);
  const allSelected = deletable.length > 0 && selected.size === deletable.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(deletable.map((g) => g.organization_id)));

  const runBulkDelete = () => {
    const n = selected.size;
    if (!window.confirm(`Delete ${n} empty organization${n === 1 ? "" : "s"}?`)) return;
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteOrganizations(Array.from(selected));
      if (res.error) setError(res.error);
      else setSelected(new Set());
    });
  };

  return (
    <>
      {deletable.length > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.9rem" }}>
          <input
            type="checkbox"
            id="orgs-all"
            checked={allSelected}
            onChange={toggleAll}
            aria-label="Select all empty organizations"
          />
          <label htmlFor="orgs-all" className="muted" style={{ fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" }}>
            Select all empty ({deletable.length})
          </label>
        </div>
      ) : null}

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
        {organizations.map((g) => {
          const empty = isEmpty(g);
          return (
            <li key={g.organization_id} className="card" style={{ marginTop: "0.7rem", display: "flex", gap: "0.7rem", alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="checkbox"
                checked={selected.has(g.organization_id)}
                onChange={() => toggle(g.organization_id)}
                disabled={!empty}
                title={empty ? undefined : "Not empty — reassign its customers and orders first"}
                aria-label={`Select ${g.name}`}
              />
              <form action={renameOrgAction} style={{ display: "flex", gap: "0.5rem", flex: "1 1 260px", minWidth: 0 }}>
                <input type="hidden" name="organization_id" value={g.organization_id} />
                <input name="name" defaultValue={g.name} required style={{ flex: 1, minWidth: 0 }} aria-label={`Rename ${g.name}`} />
                <button className="btn btn--ghost" type="submit">Rename</button>
              </form>
              <span className="chip num">
                <strong>{g.customer_count}</strong> customers · <strong>{g.order_count}</strong> orders
              </span>
              <form action={deleteOrgAction}>
                <input type="hidden" name="organization_id" value={g.organization_id} />
                {empty ? (
                  <ConfirmButton message={`Delete organization "${g.name}"?`} className="btn btn--sm btn--danger">
                    Delete
                  </ConfirmButton>
                ) : (
                  <button className="btn btn--sm btn--danger" disabled title="Reassign its customers and orders first" type="button">
                    Delete
                  </button>
                )}
              </form>
            </li>
          );
        })}
      </ul>
    </>
  );
}

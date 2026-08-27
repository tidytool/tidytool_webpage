"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminPipelineRow } from "@/lib/types";
import { STATUS_LABELS } from "@/lib/types";
import { bulkDeleteDrawers, bulkMarkDelivered, markDeliveredAction } from "@/app/admin/actions";

function ApprovalBadge({ status }: { status: AdminPipelineRow["customer_approval_status"] }) {
  if (status === "approved") return <span className="badge badge--approved">Approved</span>;
  if (status === "changes_requested") return <span className="badge badge--changes">Changes requested</span>;
  return <span className="badge badge--pending">Awaiting approval</span>;
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Drawer pipeline with multi-select: bulk mark-delivered (shared note) and
 *  bulk hard-delete (for test rows — a real drawer vanishes from ops, hence
 *  the typed confirmation). readOnly (staff) renders the list without any
 *  of the mutation controls. */
export function PipelineList({
  pipeline,
  readOnly = false,
}: {
  pipeline: AdminPipelineRow[];
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const allSelected = pipeline.length > 0 && selected.size === pipeline.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(pipeline.map((d) => d.drawer_id)));

  const runBulkDelivered = () => {
    setError(null);
    startTransition(async () => {
      const res = await bulkMarkDelivered(Array.from(selected), note);
      if (res.error) setError(res.error);
      else {
        setSelected(new Set());
        setNote("");
        router.refresh();
      }
    });
  };

  const runBulkDelete = () => {
    const n = selected.size;
    const typed = window.prompt(
      `Permanently delete ${n} drawer${n === 1 ? "" : "s"} and their event history?\n` +
      `Real (non-test) drawers will disappear from the ops pipeline.\n\nType DELETE to confirm:`,
    );
    if (typed !== "DELETE") return;
    setError(null);
    startTransition(async () => {
      const res = await bulkDeleteDrawers(Array.from(selected));
      if (res.error) setError(res.error);
      else {
        setSelected(new Set());
        router.refresh();
      }
    });
  };

  return (
    <>
      {readOnly ? null : (
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.9rem" }}>
        <input
          type="checkbox"
          id="pipeline-all"
          checked={allSelected}
          onChange={toggleAll}
          aria-label="Select all drawers"
        />
        <label htmlFor="pipeline-all" className="muted" style={{ fontSize: "0.85rem", fontWeight: 600, cursor: "pointer" }}>
          Select all ({pipeline.length})
        </label>
      </div>
      )}

      {!readOnly && selected.size > 0 ? (
        <div className="bulkbar">
          <span className="num">{selected.size} selected</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Delivery note (optional, shared)"
            aria-label="Shared delivery note"
            style={{ flex: "1 1 200px", minWidth: 0, boxShadow: "none" }}
          />
          <button className="btn btn--sm btn--primary" disabled={pending} onClick={runBulkDelivered}>
            Mark delivered
          </button>
          <button className="btn btn--sm btn--danger" disabled={pending} onClick={runBulkDelete}>
            Delete
          </button>
        </div>
      ) : null}
      {error ? <p className="banner--err" role="alert">{error}</p> : null}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {pipeline.map((d) => {
          const stage = d.status ? STATUS_LABELS[d.status] ?? d.status : "—";
          return (
            <li key={d.drawer_id} className="card" style={{ marginTop: "0.7rem", display: "flex", gap: "0.9rem" }}>
              {readOnly ? null : (
                <input
                  type="checkbox"
                  checked={selected.has(d.drawer_id)}
                  onChange={() => toggle(d.drawer_id)}
                  aria-label={`Select ${d.nickname || "untitled drawer"}`}
                  style={{ marginTop: "0.25rem", flexShrink: 0 }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "start" }}>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={{ margin: 0 }}>
                      {d.order_id ? (
                        <a href={`/admin/orders/${d.order_id}`} style={{ color: "inherit" }}>
                          {d.nickname || "Untitled drawer"}
                        </a>
                      ) : (
                        d.nickname || "Untitled drawer"
                      )}
                    </h3>
                    <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.88rem" }}>
                      {d.customer_name || "No customer"}
                      {d.customer_email ? ` · ${d.customer_email}` : ""}
                      {d.project_name ? ` · ${d.project_name}` : ""}
                    </p>
                  </div>
                  <ApprovalBadge status={d.customer_approval_status} />
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem", marginTop: "0.7rem", alignItems: "center" }}>
                  <span className="chip">Stage <strong>{stage}</strong></span>
                  {d.approved_at ? (
                    <span className="chip">Approved <strong>{formatDate(d.approved_at)}</strong>{d.approved_by ? ` by ${d.approved_by}` : ""}</span>
                  ) : null}
                  <span className="chip">Created <strong>{formatDate(d.created_at)}</strong></span>
                </div>
                {readOnly ? null : (
                <form action={markDeliveredAction} style={{ display: "flex", gap: "0.5rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
                  <input type="hidden" name="drawer_id" value={d.drawer_id} />
                  <input
                    name="note"
                    placeholder="Delivery note (optional)"
                    style={{ flex: "1 1 200px", minWidth: 0 }}
                  />
                  <button className="btn btn--ghost" type="submit">
                    Mark delivered
                  </button>
                </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

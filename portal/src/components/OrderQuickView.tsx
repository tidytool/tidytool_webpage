"use client";

/**
 * Quick-view popup for the admin orders list — opened by double-clicking a
 * row. Shows the order at a glance without leaving the list: each drawer with
 * a large photo, its stage/approval chips, design-preview + DXF links, and an
 * on-demand in-page 3D scan viewer. Data comes from the same
 * get_admin_order_detail RPC the full order page uses, fetched client-side on
 * open. Built on the native <dialog> like Modal.tsx (Esc + backdrop close for
 * free), but externally controlled so the table row can be the trigger.
 */
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  STATUS_LABELS,
  formatCents,
  type AdminOrderDetail,
  type AdminOrderRow,
} from "@/lib/types";
import { dxfPublicUrl } from "@/lib/dxf";
import { ScanViewer } from "@/components/ScanViewer";

function DrawerCard({
  drawer,
  boxLabel,
  copies,
}: {
  drawer: AdminOrderDetail["drawers"][number];
  boxLabel: string | null;
  copies: number;
}) {
  const [show3d, setShow3d] = useState(false);
  const stage =
    drawer.stage_label ??
    (drawer.status ? STATUS_LABELS[drawer.status] ?? drawer.status : "—");
  const dxfUrl = dxfPublicUrl(drawer.dxf_url);
  const name = drawer.nickname || "Untitled drawer";

  return (
    <div className="qv__drawer">
      {drawer.photo_url ? (
        <a href={drawer.photo_url} target="_blank" rel="noopener noreferrer" title="Open full-size photo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="qv__photo" src={drawer.photo_url} alt={`Photo of ${name}`} loading="lazy" />
        </a>
      ) : (
        <div className="qv__photo qv__photo--empty">No photo yet</div>
      )}

      <div className="qv__drawer-head">
        <strong>{name}</strong>
        <span className="chip">
          Stage <strong>{stage}</strong>
        </span>
        <span className="chip">
          Approval <strong>{drawer.customer_approval_status}</strong>
        </span>
        {drawer.tier && drawer.tier !== "essential" ? (
          <span className="chip">{drawer.tier.charAt(0).toUpperCase() + drawer.tier.slice(1)}</span>
        ) : null}
        {copies > 1 ? <span className="chip">×{copies} physical</span> : null}
        {boxLabel ? <span className="sub">in {boxLabel}</span> : null}
      </div>

      <p className="qv__links">
        {drawer.point_cloud_url ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-pressed={show3d}
            onClick={() => setShow3d((v) => !v)}
          >
            {show3d ? "Hide 3D scan" : "View 3D scan"}
          </button>
        ) : null}
        {drawer.design_preview_url ? (
          <a href={drawer.design_preview_url} target="_blank" rel="noopener noreferrer">
            Design preview →
          </a>
        ) : null}
        {dxfUrl ? (
          <a href={dxfUrl} download>
            DXF →
          </a>
        ) : null}
      </p>

      {show3d && drawer.point_cloud_url ? (
        <ScanViewer url={drawer.point_cloud_url} label={name} />
      ) : null}
    </div>
  );
}

export function OrderQuickView({
  order,
  onClose,
}: {
  /** The list row to preview, or null when the popup is closed. */
  order: AdminOrderRow | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = order !== null;
  const orderId = order?.order_id ?? null;

  // Open/close the native dialog to match the controlled state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Fetch the order detail when a row is opened.
  useEffect(() => {
    if (!orderId) {
      setDetail(null);
      setError(null);
      return;
    }
    let stale = false;
    const supabase = createClient();
    supabase
      .rpc("get_admin_order_detail", { p_order_id: orderId })
      .then(({ data, error: err }) => {
        if (stale) return;
        if (err) setError(err.message);
        else setDetail(data as AdminOrderDetail);
      });
    return () => {
      stale = true;
    };
  }, [orderId]);

  const title = order
    ? order.project_name || order.customer_name || "Order"
    : "Order";
  const boxes = detail?.boxes ?? [];
  const drawers = detail?.drawers ?? [];

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      onClick={(e) => {
        // A click whose target is the <dialog> itself is the ::backdrop.
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <div className="modal__panel modal__panel--wide">
        <div className="modal__head">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </h2>
            {order ? (
              <p className="sub muted" style={{ margin: "0.2rem 0 0" }}>
                {order.customer_name || "Unknown"}
                {order.organization_name ? ` · ${order.organization_name}` : ""}
                {" · "}
                <span className="num">{formatCents(order.total_price) ?? "no price"}</span>
                {" · "}
                <span className="num">{new Date(order.created_at).toLocaleDateString()}</span>
              </p>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flex: "none" }}>
            {orderId ? (
              <a className="btn btn--ghost btn--sm" href={`/admin/orders/${orderId}`}>
                Open full order →
              </a>
            ) : null}
            <button type="button" className="modal__x" aria-label="Close" onClick={() => ref.current?.close()}>
              ✕
            </button>
          </div>
        </div>

        <div className="modal__body">
          {error ? (
            <p className="banner--err" role="alert">
              {error}
            </p>
          ) : !detail && open ? (
            <p className="muted">Loading order…</p>
          ) : drawers.length === 0 ? (
            <p className="muted">No drawers on this order yet.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.9rem" }}>
              {drawers.map((d) => {
                const box = boxes.find((b) => b.id === d.box_id) ?? null;
                return (
                  <DrawerCard
                    key={d.id}
                    drawer={d}
                    boxLabel={box?.label ?? null}
                    copies={(box ? box.quantity : 1) * d.quantity}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

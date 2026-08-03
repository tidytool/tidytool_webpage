"use client";

/**
 * Quick-view popup for a single drawer — opened by clicking a drawer row on
 * the admin order detail page. A closer look without leaving the
 * order: the photo at full width, stage/approval chips, design-preview + DXF
 * links, and an on-demand in-page 3D scan viewer (ScanViewer/three.js). No
 * fetch needed — the page already has every field. Built on the native
 * <dialog> like Modal.tsx (Esc + backdrop close for free), but externally
 * controlled so the row itself can be the trigger.
 */
import { useEffect, useRef, useState } from "react";
import { STATUS_LABELS } from "@/lib/types";
import { dxfPublicUrl } from "@/lib/dxf";
import { ScanViewer } from "@/components/ScanViewer";

/** Everything the popup shows — supplied by the row that was double-clicked. */
export type DrawerQuickViewData = {
  id: string;
  nickname: string | null;
  status: string | null;
  stage_label?: string | null;
  customer_approval_status: string;
  tier?: string | null;
  photo_url: string | null;
  design_preview_url: string | null;
  point_cloud_url: string | null;
  dxf_url: string | null;
  /** Parent box label, or null for a loose tray. */
  boxLabel: string | null;
  /** Physical copies (box quantity × drawer quantity). */
  copies: number;
};

export function DrawerQuickView({
  drawer,
  onClose,
}: {
  /** The drawer to preview, or null when the popup is closed. */
  drawer: DrawerQuickViewData | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [show3d, setShow3d] = useState(false);

  const open = drawer !== null;

  // Open/close the native dialog to match the controlled state; reset the 3D
  // toggle so the next drawer doesn't inherit a running viewer.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      setShow3d(false);
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const name = drawer?.nickname || "Untitled drawer";
  const stage = drawer
    ? drawer.stage_label ??
      (drawer.status ? STATUS_LABELS[drawer.status] ?? drawer.status : "—")
    : "—";
  const dxfUrl = drawer ? dxfPublicUrl(drawer.dxf_url) : null;

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
          <h2 style={{ margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </h2>
          <button type="button" className="modal__x" aria-label="Close" onClick={() => ref.current?.close()}>
            ✕
          </button>
        </div>

        {drawer ? (
          <div className="modal__body">
            {drawer.photo_url ? (
              <a href={drawer.photo_url} target="_blank" rel="noopener noreferrer" title="Open full-size photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="qv__photo" src={drawer.photo_url} alt={`Photo of ${name}`} />
              </a>
            ) : (
              <div className="qv__photo qv__photo--empty">No photo yet</div>
            )}

            <div className="qv__drawer-head">
              <span className="chip">
                Stage <strong>{stage}</strong>
              </span>
              <span className="chip">
                Approval <strong>{drawer.customer_approval_status}</strong>
              </span>
              {drawer.tier && drawer.tier !== "essential" ? (
                <span className="chip">{drawer.tier.charAt(0).toUpperCase() + drawer.tier.slice(1)}</span>
              ) : null}
              {drawer.copies > 1 ? <span className="chip">×{drawer.copies} physical</span> : null}
              {drawer.boxLabel ? <span className="sub">in {drawer.boxLabel}</span> : null}
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
        ) : null}
      </div>
    </dialog>
  );
}

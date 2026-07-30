"use client";

/**
 * The order shown as an object, not two parallel lists. Boxes render as
 * slide-down accordions with their drawers nested inside; drawers in no box are
 * grouped as "Loose trays" (redesign brief #1). The default is read-optimized —
 * open a box to see what's in it — and all the restructuring controls (create a
 * box, move a drawer, set copies, rename, mark delivered) live behind a single
 * "Organize" toggle so refinement is an optional path, not the strict flow
 * (brief #3). Reuses BoxCard + DrawerBoxControls so the good dirty-state save
 * affordances carry over unchanged.
 */
import { useState } from "react";
import { BoxCard } from "@/components/BoxCard";
import { DrawerBoxControls } from "@/components/DrawerBoxControls";
import { createBoxAction } from "@/app/admin/box-actions";
import { updateNicknameAction, markDeliveredAction } from "@/app/admin/actions";
import { STATUS_LABELS, type ApprovalStatus } from "@/lib/types";

type Box = { id: string; label: string; quantity: number };
type DrawerVM = {
  id: string;
  nickname: string | null;
  status: string | null;
  customer_approval_status: ApprovalStatus;
  photo_url: string | null;
  design_preview_url: string | null;
  point_cloud_url: string | null;
  box_id: string | null;
  quantity: number;
  /** essential | professional | premium; missing (pre-migration) renders as essential. */
  tier?: string | null;
};

function Model3D({ url }: { url: string }) {
  const isUsdz = url.toLowerCase().endsWith(".usdz");
  return (
    <details className="reveal" style={{ marginTop: "0.4rem" }}>
      <summary>Load 3D model</summary>
      <p style={{ margin: "0.4rem 0 0", fontSize: "0.9rem" }}>
        {isUsdz ? (
          <a href={url} rel="ar noopener noreferrer">
            Open scan in 3D (QuickLook) →
          </a>
        ) : (
          <a href={url} download>
            Download model file →
          </a>
        )}
      </p>
    </details>
  );
}

function DrawerRow({
  orderId,
  drawer,
  boxes,
  organize,
}: {
  orderId: string;
  drawer: DrawerVM;
  boxes: Box[];
  organize: boolean;
}) {
  const box = boxes.find((b) => b.id === drawer.box_id) ?? null;
  const physical = (box ? box.quantity : 1) * drawer.quantity;
  const stage = drawer.status ? STATUS_LABELS[drawer.status] ?? drawer.status : "—";

  return (
    <div className="drawer-row">
      {drawer.photo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="drawer-row__thumb"
          src={drawer.photo_url}
          alt={drawer.nickname ? `Photo of ${drawer.nickname}` : "Drawer photo"}
          loading="lazy"
        />
      ) : (
        <div className="drawer-row__thumb drawer-row__thumb--empty" aria-hidden="true" />
      )}

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
          <strong>{drawer.nickname || "Untitled drawer"}</strong>
          {physical > 1 ? <span className="chip">×{physical} physical</span> : null}
          {drawer.tier && drawer.tier !== "essential" ? (
            <span className="chip">{drawer.tier.charAt(0).toUpperCase() + drawer.tier.slice(1)}</span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
          <span className="chip">
            Stage <strong>{stage}</strong>
          </span>
          <span className="chip">
            Approval <strong>{drawer.customer_approval_status}</strong>
          </span>
        </div>
        {drawer.design_preview_url ? (
          <p style={{ margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
            <a href={drawer.design_preview_url} target="_blank" rel="noopener noreferrer">
              Design preview →
            </a>
          </p>
        ) : null}

        {organize ? (
          <div style={{ marginTop: "0.6rem" }}>
            {drawer.point_cloud_url ? <Model3D url={drawer.point_cloud_url} /> : null}

            <form action={updateNicknameAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem" }}>
              <input type="hidden" name="drawer_id" value={drawer.id} />
              <input type="hidden" name="order_id" value={orderId} />
              <input name="nickname" defaultValue={drawer.nickname ?? ""} placeholder="Nickname" style={{ flex: 1, minWidth: 0 }} />
              <button className="btn btn--ghost" type="submit">
                Rename
              </button>
            </form>

            <DrawerBoxControls
              orderId={orderId}
              drawer={{ id: drawer.id, box_id: drawer.box_id, quantity: drawer.quantity, tier: drawer.tier ?? "essential" }}
              boxes={boxes}
            />

            <form action={markDeliveredAction} style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
              <input type="hidden" name="drawer_id" value={drawer.id} />
              <input name="note" placeholder="Delivery note (optional)" style={{ flex: 1, minWidth: 0 }} />
              <button className="btn btn--ghost" type="submit">
                Delivered
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OrderContents({
  orderId,
  boxes,
  drawers,
}: {
  orderId: string;
  boxes: Box[];
  drawers: DrawerVM[];
}) {
  const [organize, setOrganize] = useState(false);
  const trays = drawers.filter((d) => !d.box_id);
  const physicalTotal = drawers.reduce((s, d) => {
    const b = boxes.find((x) => x.id === d.box_id) ?? null;
    return s + (b ? b.quantity : 1) * d.quantity;
  }, 0);
  const autoOpen = boxes.length <= 2;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>
          Contents{" "}
          <span className="muted num" style={{ fontWeight: 500 }}>
            ({boxes.length} box{boxes.length === 1 ? "" : "es"} · {drawers.length} drawer
            {drawers.length === 1 ? "" : "s"}
            {physicalTotal !== drawers.length ? ` · ×${physicalTotal} physical` : ""})
          </span>
        </h2>
        <button
          type="button"
          className={organize ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
          onClick={() => setOrganize((v) => !v)}
          aria-pressed={organize}
        >
          {organize ? "Done organizing" : "Organize"}
        </button>
      </div>

      <p className="muted" style={{ fontSize: "0.85rem", margin: "0.3rem 0 0.9rem" }}>
        {organize
          ? "Group drawers into boxes, set copies, rename, or mark delivered. A box duplicates as a unit; drawers outside a box are trays. Design is quoted once; foam per physical copy."
          : "Boxes duplicate as a unit; drawers outside a box are trays. Open a box to see the drawers inside — or hit Organize to restructure."}
      </p>

      {boxes.length === 0 && drawers.length === 0 ? (
        <p className="muted">No drawers on this order yet.</p>
      ) : null}

      <div style={{ display: "grid", gap: "0.8rem" }}>
        {boxes.map((b) => {
          const inBox = drawers.filter((d) => d.box_id === b.id);
          const boxPhysical = b.quantity * inBox.reduce((s, d) => s + d.quantity, 0);
          return (
            <details key={b.id} className="box-acc card" open={autoOpen}>
              <summary className="box-acc__sum">
                <span className="box-acc__title">
                  <strong>{b.label}</strong>
                  <span className="chip">
                    ×{b.quantity} {b.quantity === 1 ? "copy" : "copies"}
                  </span>
                  <span className="muted num" style={{ fontSize: "0.85rem" }}>
                    {inBox.length} drawer{inBox.length === 1 ? "" : "s"} · ×{boxPhysical} physical
                  </span>
                </span>
              </summary>
              <div className="box-acc__body">
                {organize ? (
                  <div style={{ marginBottom: inBox.length ? "0.7rem" : 0 }}>
                    <BoxCard orderId={orderId} box={{ id: b.id, label: b.label, quantity: b.quantity }} drawerCount={inBox.length} />
                  </div>
                ) : null}
                {inBox.length === 0 ? (
                  <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                    No drawers in this box{organize ? " yet — assign drawers from the tray list below." : "."}
                  </p>
                ) : (
                  <div style={{ display: "grid", gap: "0.6rem" }}>
                    {inBox.map((d) => (
                      <DrawerRow key={d.id} orderId={orderId} drawer={d} boxes={boxes} organize={organize} />
                    ))}
                  </div>
                )}
              </div>
            </details>
          );
        })}

        {trays.length > 0 || organize ? (
          <details className="box-acc card" open={autoOpen || organize}>
            <summary className="box-acc__sum">
              <span className="box-acc__title">
                <strong>Loose trays</strong>
                <span className="muted num" style={{ fontSize: "0.85rem" }}>
                  {trays.length} drawer{trays.length === 1 ? "" : "s"} · not in a box
                </span>
              </span>
            </summary>
            <div className="box-acc__body">
              {trays.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.85rem", margin: 0 }}>
                  No loose trays — every drawer is in a box.
                </p>
              ) : (
                <div style={{ display: "grid", gap: "0.6rem" }}>
                  {trays.map((d) => (
                    <DrawerRow key={d.id} orderId={orderId} drawer={d} boxes={boxes} organize={organize} />
                  ))}
                </div>
              )}
            </div>
          </details>
        ) : null}
      </div>

      {organize ? (
        <form
          action={createBoxAction}
          className="card"
          style={{ marginTop: "0.8rem", display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end", maxWidth: "440px" }}
        >
          <input type="hidden" name="order_id" value={orderId} />
          <label className="ctrl" style={{ flex: "1 1 160px" }}>
            <span>New box label</span>
            <input name="label" placeholder="e.g. Blue box" required />
          </label>
          <label className="ctrl" style={{ flex: "0 0 80px" }}>
            <span>Copies</span>
            <input name="quantity" type="number" min="1" step="1" defaultValue={1} />
          </label>
          <button className="btn btn--primary" type="submit">
            Add box
          </button>
        </form>
      ) : null}
    </section>
  );
}

"use client";

/**
 * Per-drawer placement controls: which box it belongs to + how many copies of
 * this drawer, with a LIVE "= N physical" readout and a single Apply button
 * that only lights up when something changed. Replaces the old separate
 * Move / Set buttons so there's one obvious save, and you can see the physical
 * count update before you even click.
 */
import { useState } from "react";
import { updateDrawerPlacementAction } from "@/app/admin/box-actions";

type Box = { id: string; label: string; quantity: number };
type Drawer = { id: string; box_id: string | null; quantity: number };

export function DrawerBoxControls({
  orderId,
  drawer,
  boxes,
}: {
  orderId: string;
  drawer: Drawer;
  boxes: Box[];
}) {
  const [boxId, setBoxId] = useState(drawer.box_id ?? "");
  const [quantity, setQuantity] = useState(String(drawer.quantity));
  const qtyNum = Math.max(1, Math.floor(Number(quantity) || 1));
  const selectedBox = boxes.find((b) => b.id === boxId) ?? null;
  const physical = (selectedBox ? selectedBox.quantity : 1) * qtyNum;
  const dirty = boxId !== (drawer.box_id ?? "") || qtyNum !== drawer.quantity;

  return (
    <form
      action={updateDrawerPlacementAction}
      style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "end" }}
    >
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="drawer_id" value={drawer.id} />
      <label className="ctrl" style={{ flex: "1 1 130px" }}>
        <span>Box</span>
        <select name="box_id" value={boxId} onChange={(e) => setBoxId(e.target.value)}>
          <option value="">Tray (no box)</option>
          {boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label} (×{b.quantity})
            </option>
          ))}
        </select>
      </label>
      <label className="ctrl" style={{ flex: "0 0 68px" }}>
        <span>Copies</span>
        <input name="quantity" type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      <span className="chip" style={{ alignSelf: "center" }}>
        = <strong>×{physical}</strong> physical
      </span>
      <button className={dirty ? "btn btn--primary" : "btn btn--ghost"} type="submit" disabled={!dirty}>
        {dirty ? "Apply" : "Applied"}
      </button>
    </form>
  );
}

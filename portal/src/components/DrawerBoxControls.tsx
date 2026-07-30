"use client";

/**
 * Per-drawer placement + tier controls: which box it belongs to, how many
 * copies, and the product tier (Essential/Professional/Premium — picks the
 * $/sqft rate), with a LIVE "= N physical" readout and a single Apply button
 * that only lights up when something changed. One obvious save; you see the
 * physical count update before you even click.
 */
import { useState } from "react";
import { updateDrawerPlacementAction } from "@/app/admin/box-actions";

type Box = { id: string; label: string; quantity: number };
type Drawer = { id: string; box_id: string | null; quantity: number; tier: string };

const TIER_OPTIONS = [
  { value: "essential", label: "Essential" },
  { value: "professional", label: "Professional" },
  { value: "premium", label: "Premium" },
];

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
  const [tier, setTier] = useState(drawer.tier || "essential");
  const qtyNum = Math.max(1, Math.floor(Number(quantity) || 1));
  const selectedBox = boxes.find((b) => b.id === boxId) ?? null;
  const physical = (selectedBox ? selectedBox.quantity : 1) * qtyNum;
  const dirty =
    boxId !== (drawer.box_id ?? "") || qtyNum !== drawer.quantity || tier !== (drawer.tier || "essential");

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
      <label className="ctrl" style={{ flex: "0 0 128px" }}>
        <span>Tier</span>
        <select name="tier" value={tier} onChange={(e) => setTier(e.target.value)}>
          {TIER_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
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

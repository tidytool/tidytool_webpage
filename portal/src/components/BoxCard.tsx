"use client";

/**
 * One editable box card. Tracks unsaved edits locally so the Save button
 * *announces* itself: it turns primary + "Save changes" and an "Unsaved" hint
 * appears the moment you change the label or copies, and drops to a disabled
 * "Saved" once persisted. This is the fix for "I typed 2 and it didn't stick" —
 * the UI now makes it obvious the change hasn't been saved yet.
 */
import { useState } from "react";
import { updateBoxAction, deleteBoxAction } from "@/app/admin/box-actions";

type Box = { id: string; label: string; quantity: number };

export function BoxCard({ orderId, box, drawerCount }: { orderId: string; box: Box; drawerCount: number }) {
  const [label, setLabel] = useState(box.label);
  const [quantity, setQuantity] = useState(String(box.quantity));
  const qtyNum = Math.max(1, Math.floor(Number(quantity) || 1));
  const dirty = label.trim() !== box.label || qtyNum !== box.quantity;

  return (
    <div className="card" style={{ flex: "1 1 260px", maxWidth: "340px", borderColor: dirty ? "var(--c-brand, #d33)" : undefined }}>
      <form action={updateBoxAction} style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "end" }}>
        <input type="hidden" name="order_id" value={orderId} />
        <input type="hidden" name="box_id" value={box.id} />
        <label className="ctrl" style={{ flex: "1 1 130px" }}>
          <span>Label</span>
          <input name="label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="ctrl" style={{ flex: "0 0 74px" }}>
          <span>Copies</span>
          <input name="quantity" type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <button className={dirty ? "btn btn--primary" : "btn btn--ghost"} type="submit" disabled={!dirty}>
          {dirty ? "Save changes" : "Saved"}
        </button>
      </form>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem", gap: "0.5rem" }}>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          {dirty ? (
            <strong style={{ color: "var(--c-brand, #d33)" }}>Unsaved — click Save changes</strong>
          ) : (
            <>{drawerCount} drawer{drawerCount === 1 ? "" : "s"} · ×{box.quantity} {box.quantity === 1 ? "copy" : "copies"}</>
          )}
        </span>
        <form action={deleteBoxAction}>
          <input type="hidden" name="order_id" value={orderId} />
          <input type="hidden" name="box_id" value={box.id} />
          <button className="btn btn--ghost" type="submit" style={{ color: "var(--c-danger, #b00)" }}>
            Delete box
          </button>
        </form>
      </div>
    </div>
  );
}

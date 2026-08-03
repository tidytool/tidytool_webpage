"use client";

/**
 * Customer tool-label editor (/labels/[id]) — spec:
 * planning/customer-label-tool-spec.md.
 *
 * One view: the drawer's orthographic photo (photo_url IS the ortho render)
 * with color-coded, numbered pocket outlines overlaid. Pockets come from the
 * DXF, parsed client-side (src/lib/labels.ts); the overlay maps the DXF
 * boundary onto dimensions.reference_corners by bilinear interpolation.
 *
 * States:
 *  - corners present → overlay + entry list (the normal path)
 *  - no corners + staff → align mode: drag the four drawer corners on the
 *    photo, save via set_drawer_reference_corners (backfills legacy drawers);
 *    staff can also re-align existing corners
 *  - no corners + customer → photo and a numbered plan drawing side by side
 *
 * Drafts auto-save (debounced; saves are SERIALIZED through a promise chain so
 * a slow older request can never overwrite a newer one — replace-all semantics
 * make a stale write total, not partial). An explicit Submit stamps
 * labels_submitted_* with a typed name (shared logins). `editable` comes from
 * the server (stage ≥ designed, not locked/cancelled) — no stage constants
 * client-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { dxfPublicUrl } from "@/lib/dxf";
import {
  extractPockets,
  referenceCorners,
  dxfToPhoto,
  pocketColor,
  type CornerQuad,
  type PocketSet,
} from "@/lib/labels";

export type LabelRowData = {
  pocket_key: string;
  pocket_index: number;
  label_text: string | null;
  na: boolean;
  dxf_revision: number | null;
};

export type DrawerLabelsData = {
  drawer: {
    id: string;
    nickname: string | null;
    photo_url: string | null;
    dxf_url: string | null;
    dimensions: unknown;
    dxf_revision: number | null;
    stage: string | null;
    stage_sort: number | null;
    labels_submitted_at: string | null;
    labels_submitted_by: string | null;
    locked: boolean;
    /** Server-computed: stage ≥ designed AND not locked/cancelled. */
    editable: boolean;
    is_staff: boolean;
  };
  labels: LabelRowData[];
};

type Row = { key: string; index: number; text: string; na: boolean };

const MAX_TEXT = 500;

const DEFAULT_QUAD: CornerQuad = [
  [0.12, 0.12],
  [0.88, 0.12],
  [0.88, 0.88],
  [0.12, 0.88],
];

export function LabelEditor({
  data,
  defaultName,
}: {
  data: DrawerLabelsData;
  defaultName?: string;
}) {
  const router = useRouter();
  const d = data.drawer;
  const canEdit = d.editable;
  const dxfUrl = dxfPublicUrl(d.dxf_url);
  const savedQuad = useMemo(() => referenceCorners(d.dimensions), [d.dimensions]);

  // ---- DXF → pockets -------------------------------------------------------
  const [pocketSet, setPocketSet] = useState<PocketSet | null>(null);
  const [dxfState, setDxfState] = useState<"loading" | "ready" | "error" | "none">(
    dxfUrl ? "loading" : "none",
  );
  useEffect(() => {
    let cancelled = false;
    if (!dxfUrl) return;
    (async () => {
      try {
        const res = await fetch(dxfUrl);
        if (!res.ok) throw new Error(`DXF fetch ${res.status}`);
        const text = await res.text();
        const set = extractPockets(text);
        if (cancelled) return;
        if (!set || set.pockets.length === 0) setDxfState("error");
        else {
          setPocketSet(set);
          setDxfState("ready");
        }
      } catch {
        if (!cancelled) setDxfState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dxfUrl]);

  // ---- rows (merge saved labels onto parsed pockets) -----------------------
  const [rows, setRows] = useState<Row[] | null>(null);
  const [nickname, setNickname] = useState(d.nickname ?? "");
  // Latest state for the serialized saver (avoids stale closures).
  const rowsRef = useRef<Row[] | null>(null);
  const nicknameRef = useRef(nickname);
  rowsRef.current = rows;
  nicknameRef.current = nickname;

  useEffect(() => {
    if (!pocketSet) return;
    const saved = new Map(data.labels.map((l) => [l.pocket_key, l]));
    setRows(
      pocketSet.pockets.map((p) => {
        const s = saved.get(p.key);
        return { key: p.key, index: p.index, text: s?.label_text ?? "", na: s?.na ?? false };
      }),
    );
    // data.labels is the server snapshot from mount — merging once per parse
    // is intentional; live edits own the state after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pocketSet]);

  const designChanged = useMemo(
    () =>
      data.labels.some(
        (l) => l.dxf_revision !== null && d.dxf_revision !== null && l.dxf_revision !== d.dxf_revision,
      ),
    [data.labels, d.dxf_revision],
  );

  // ---- autosave (debounced + serialized + sequenced) -----------------------
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Chain guarantees at most one request in flight and in issue order; the
  // sequence number keeps a superseded request from reporting its status.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveSeq = useRef(0);

  const performSave = useCallback(async (): Promise<{ error: { message?: string } | null }> => {
    const current = rowsRef.current;
    if (!current) return { error: null };
    const seq = ++saveSeq.current;
    let result: { error: { message?: string } | null } = { error: null };
    const run = saveChain.current.then(async () => {
      const supabase = createClient();
      const { error } = await supabase.rpc("save_drawer_labels", {
        p_drawer_id: d.id,
        p_rows: current.map((r) => ({
          pocket_key: r.key,
          pocket_index: r.index,
          label_text: r.na ? null : r.text,
          na: r.na,
        })),
        p_dxf_revision: d.dxf_revision,
        p_nickname: nicknameRef.current.trim() || null,
      });
      result = { error: error ?? null };
      if (seq === saveSeq.current) setSaveState(error ? "error" : "saved");
    });
    saveChain.current = run.catch(() => undefined);
    await run;
    return result;
  }, [d.id, d.dxf_revision]);

  const queueSave = useCallback(() => {
    if (!canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(() => {
      void performSave();
    }, 900);
  }, [canEdit, performSave]);

  const updateRow = (key: string, patch: Partial<Row>) => {
    setRows((prev) => (prev ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r)) : prev));
    queueSave();
  };

  // ---- submit --------------------------------------------------------------
  const [name, setName] = useState(defaultName ?? d.labels_submitted_by ?? "");
  const [submitState, setSubmitState] = useState<"idle" | "busy" | "done">(
    d.labels_submitted_at ? "done" : "idle",
  );
  const [error, setError] = useState("");
  const done = rows ? rows.filter((r) => r.na || r.text.trim() !== "").length : 0;
  const total = rows?.length ?? 0;
  const complete = total > 0 && done === total;

  async function submit() {
    setError("");
    if (!name.trim()) {
      setError("Please enter your name first.");
      return;
    }
    setSubmitState("busy");
    // Flush the pending draft first — and abort if that write fails, so the
    // submit can never stamp approval over rows older than the screen.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const flushed = await performSave();
    if (flushed.error) {
      setSubmitState("idle");
      setError(flushed.error.message || "Couldn't save your labels — please try again.");
      return;
    }
    const supabase = createClient();
    const { error: e } = await supabase.rpc("submit_drawer_labels", {
      p_drawer_id: d.id,
      p_name: name.trim(),
      p_nickname: nickname.trim() || null,
      p_expected_count: total,
    });
    if (e) {
      setSubmitState("idle");
      setError(e.message || "Something went wrong. Please try again.");
      return;
    }
    setSubmitState("done");
    router.refresh();
  }

  // ---- hover sync ----------------------------------------------------------
  const [hot, setHot] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const jumpTo = (key: string) => {
    const el = rowRefs.current.get(key);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    const input = el?.querySelector<HTMLInputElement>('input[type="text"]');
    setTimeout(() => input?.focus({ preventScroll: true }), 250);
  };

  // ---- align mode (staff: backfill legacy drawers, or re-align) ------------
  const [alignQuad, setAlignQuad] = useState<CornerQuad>(DEFAULT_QUAD);
  const [aligning, setAligning] = useState(false);
  const [alignBusy, setAlignBusy] = useState(false);
  const photoBoxRef = useRef<HTMLDivElement>(null);
  const dragIdx = useRef<number | null>(null);

  const startAligning = () => {
    setAlignQuad(savedQuad ?? DEFAULT_QUAD);
    setAligning(true);
  };
  const onAlignPointer = (e: React.PointerEvent) => {
    if (dragIdx.current === null) return;
    const box = photoBoxRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    const i = dragIdx.current;
    setAlignQuad((q) => q.map((c, j) => (j === i ? [x, y] : c)) as CornerQuad);
  };
  async function saveAlignment() {
    setAlignBusy(true);
    setError("");
    const supabase = createClient();
    const { error: e } = await supabase.rpc("set_drawer_reference_corners", {
      p_drawer_id: d.id,
      p_corners: alignQuad,
    });
    setAlignBusy(false);
    if (e) {
      setError(e.message || "Could not save alignment.");
      return;
    }
    setAligning(false);
    router.refresh();
  }

  // ---- render helpers ------------------------------------------------------
  // While aligning, the draft quad wins so staff see the outlines follow.
  const quad = aligning ? alignQuad : savedQuad;

  // Natural photo pixel size — the overlay draws in image-pixel space so
  // circles and text keep their aspect on non-square photos. The ref callback
  // handles cache hits where `load` fires before hydration and onLoad never
  // runs; onLoad stays as the fallback for normal loads.
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const readNat = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth && img.naturalHeight) {
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, []);
  const badgeR = nat ? Math.max(10, Math.min(nat.w, nat.h) * 0.018) : 12;

  function overlayPath(points: [number, number][], q: CornerQuad): string {
    if (!pocketSet || !nat) return "";
    return (
      points
        .map(([x, y], i) => {
          const [px, py] = dxfToPhoto(x, y, pocketSet.bounds, q);
          return `${i === 0 ? "M" : "L"}${(px * nat.w).toFixed(1)},${(py * nat.h).toFixed(1)}`;
        })
        .join("") + "Z"
    );
  }

  function planView() {
    if (!pocketSet) return null;
    const { minX, minY, maxX, maxY } = pocketSet.bounds;
    const pad = Math.max(maxX - minX, maxY - minY) * 0.03;
    return (
      <svg
        className="lbl-plan"
        viewBox={`${minX - pad} ${-maxY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`}
        aria-label="Numbered plan drawing of the drawer pockets"
      >
        <rect
          x={minX}
          y={-maxY}
          width={maxX - minX}
          height={maxY - minY}
          rx={(maxX - minX) * 0.02}
          fill="#fbfcfd"
          stroke="var(--c-border)"
        />
        {pocketSet.pockets.map((p) => {
          const na = rows?.find((r) => r.key === p.key)?.na;
          const col = na ? "#9AA6AE" : pocketColor(p.index);
          return (
            <g
              key={p.key}
              className={`lbl-pocket${hot === p.key ? " lbl-pocket--hot" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`Pocket ${p.index}`}
              onMouseEnter={() => setHot(p.key)}
              onMouseLeave={() => setHot(null)}
              onFocus={() => setHot(p.key)}
              onBlur={() => setHot(null)}
              onClick={() => jumpTo(p.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  jumpTo(p.key);
                }
              }}
            >
              <path
                d={p.points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${-y}`).join("") + "Z"}
                fill={col}
                fillOpacity={na ? 0.15 : 0.3}
                stroke={col}
                strokeWidth={hot === p.key ? 0.14 : 0.06}
              />
              <circle cx={p.cx} cy={-p.cy} r={0.55} fill="#fff" stroke={col} strokeWidth={0.08} />
              <text x={p.cx} y={-p.cy} textAnchor="middle" dominantBaseline="central" fontSize={0.6} fontWeight={800} fill="var(--c-text)">
                {p.index}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  const showOverlay = dxfState === "ready" && !!quad && !!d.photo_url;
  const showAlignPrompt = d.is_staff && !savedQuad && dxfState === "ready" && !!d.photo_url;
  const showRealign = d.is_staff && !!savedQuad && dxfState === "ready" && !!d.photo_url && !aligning;

  return (
    <div className="lbl-layout">
      {/* ---------------- visual ---------------- */}
      <section className="card">
        {d.photo_url ? (
          <div
            ref={photoBoxRef}
            className="lbl-photo-box"
            onPointerMove={aligning ? onAlignPointer : undefined}
            onPointerUp={aligning ? () => (dragIdx.current = null) : undefined}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={readNat}
              className="lbl-photo"
              src={d.photo_url}
              alt={`Top-down photo of ${d.nickname || "your drawer"}`}
              onLoad={(e) => readNat(e.currentTarget)}
            />
            {(showOverlay || aligning) && pocketSet && quad && nat ? (
              <svg className="lbl-overlay" viewBox={`0 0 ${nat.w} ${nat.h}`} preserveAspectRatio="none">
                {pocketSet.pockets.map((p) => {
                  const na = rows?.find((r) => r.key === p.key)?.na;
                  const col = na ? "#9AA6AE" : pocketColor(p.index);
                  const [bx, by] = dxfToPhoto(p.cx, p.cy, pocketSet.bounds, quad);
                  return (
                    <g
                      key={p.key}
                      className={`lbl-pocket${hot === p.key ? " lbl-pocket--hot" : ""}`}
                      role={aligning ? undefined : "button"}
                      tabIndex={aligning ? undefined : 0}
                      aria-label={`Pocket ${p.index}`}
                      onMouseEnter={() => setHot(p.key)}
                      onMouseLeave={() => setHot(null)}
                      onFocus={() => setHot(p.key)}
                      onBlur={() => setHot(null)}
                      onClick={() => (aligning ? undefined : jumpTo(p.key))}
                      onKeyDown={(e) => {
                        if (!aligning && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          jumpTo(p.key);
                        }
                      }}
                    >
                      <path
                        d={overlayPath(p.points, quad)}
                        fill={col}
                        fillOpacity={hot === p.key ? 0.25 : 0.001}
                        stroke={col}
                        strokeWidth={hot === p.key ? 5 : 3}
                        strokeDasharray={na ? "6 4" : undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                      <circle
                        cx={bx * nat.w}
                        cy={by * nat.h}
                        r={badgeR}
                        fill="#fff"
                        stroke={col}
                        strokeWidth={2.5}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={bx * nat.w}
                        y={by * nat.h}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={badgeR * 1.1}
                        fontWeight={800}
                        fill="#1E2A33"
                      >
                        {p.index}
                      </text>
                    </g>
                  );
                })}
                {aligning
                  ? alignQuad.map(([x, y], i) => (
                      <circle
                        key={i}
                        cx={x * nat.w}
                        cy={y * nat.h}
                        r={badgeR * 1.4}
                        fill="rgba(232,49,42,0.85)"
                        stroke="#fff"
                        strokeWidth={2}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "grab" }}
                        onPointerDown={(e) => {
                          (e.target as Element).setPointerCapture?.(e.pointerId);
                          dragIdx.current = i;
                        }}
                      />
                    ))
                  : null}
              </svg>
            ) : null}
          </div>
        ) : (
          <div className="lbl-photo lbl-photo--empty">No photo for this drawer yet</div>
        )}

        {aligning ? (
          <div style={{ marginTop: "0.7rem" }}>
            <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
              Drag the four dots to the drawer&apos;s corners — <b>top-left, top-right, bottom-right, bottom-left</b> as
              the design is drawn — then save. The pocket outlines will follow.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn btn--primary btn--sm" onClick={saveAlignment} disabled={alignBusy}>
                {alignBusy ? "Saving…" : "Save alignment"}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setAligning(false)} disabled={alignBusy}>
                Cancel
              </button>
            </div>
          </div>
        ) : showAlignPrompt ? (
          <div style={{ marginTop: "0.7rem" }}>
            <p className="muted" style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
              <b>Staff:</b> this drawer predates corner capture, so the outlines can&apos;t be placed on the photo yet.
              Align it once and every visit after gets the overlay.
            </p>
            <button className="btn btn--primary btn--sm" onClick={startAligning}>
              Align outlines to photo
            </button>
          </div>
        ) : showRealign ? (
          <p style={{ margin: "0.7rem 0 0" }}>
            <button className="btn btn--ghost btn--sm" onClick={startAligning}>
              Re-align outlines (staff)
            </button>
          </p>
        ) : null}

        {!savedQuad && !d.is_staff && dxfState === "ready" ? (
          <>
            <p className="muted" style={{ fontSize: "0.85rem", margin: "0.7rem 0 0.4rem" }}>
              Match the numbers below to your drawer photo above — the drawing shows where each pocket sits.
            </p>
            {planView()}
          </>
        ) : null}

        {dxfState === "loading" ? <p className="muted" style={{ marginTop: "0.7rem" }}>Loading the design…</p> : null}
        {dxfState === "error" ? (
          <p className="muted" style={{ marginTop: "0.7rem" }}>
            We couldn&apos;t read this drawer&apos;s design file. Labels can&apos;t be entered here yet — let us know and
            we&apos;ll sort it out.
          </p>
        ) : null}
        {dxfState === "none" ? (
          <p className="muted" style={{ marginTop: "0.7rem" }}>
            The design for this drawer isn&apos;t finished yet — labels open once it is.
          </p>
        ) : null}

        {showOverlay && !aligning ? (
          <p className="muted" style={{ fontSize: "0.82rem", margin: "0.7rem 0 0" }}>
            This is the flat, top-down view from your scan — outlines sit where each pocket will be cut. Click a pocket
            to jump to its entry.
          </p>
        ) : null}
      </section>

      {/* ---------------- entries ---------------- */}
      <section className="card">
        {d.locked ? (
          <p className="badge badge--pending" style={{ display: "inline-block", marginBottom: "0.8rem" }}>
            {d.stage === "in_production" || (d.stage_sort ?? 0) >= 80
              ? "In production — labels are locked"
              : "Labels are locked for this drawer"}
          </p>
        ) : null}
        {designChanged && canEdit ? (
          <p className="err" style={{ display: "block" }}>
            The design changed since these labels were entered — please re-check them.
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="drawerName">
            Drawer name <span className="muted" style={{ fontWeight: 400 }}>(rename it if you like)</span>
          </label>
          <input
            id="drawerName"
            type="text"
            value={nickname}
            maxLength={MAX_TEXT}
            disabled={!canEdit}
            onChange={(e) => {
              setNickname(e.target.value);
              queueSave();
            }}
          />
        </div>

        {rows ? (
          <>
            <div className="lbl-progress">
              <div className="lbl-ptrack">
                <div className="lbl-pfill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
              </div>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "0.35rem 0 0" }}>
                {done === total
                  ? `All ${total} pockets covered — ready to submit.`
                  : `${done} of ${total} pockets named · ${total - done} to go`}
                {canEdit ? (
                  <span style={{ float: "right" }}>
                    {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved ✓" : saveState === "error" ? "Save failed — retrying on next edit" : ""}
                  </span>
                ) : null}
              </p>
            </div>

            <ul className="lbl-rows">
              {rows.map((r) => {
                const col = pocketColor(r.index);
                return (
                  <li
                    key={r.key}
                    ref={(el) => {
                      if (el) rowRefs.current.set(r.key, el);
                      else rowRefs.current.delete(r.key);
                    }}
                    className={`lbl-row${r.na ? " lbl-row--na" : ""}${hot === r.key ? " lbl-row--hot" : ""}`}
                    style={{ ["--rc" as string]: col }}
                    onMouseEnter={() => setHot(r.key)}
                    onMouseLeave={() => setHot(null)}
                  >
                    <span className="lbl-sw">
                      {r.index}
                      {r.na || r.text.trim() ? <span className="lbl-done">✓</span> : null}
                    </span>
                    <input
                      type="text"
                      value={r.text}
                      maxLength={MAX_TEXT}
                      placeholder={r.na ? "No label" : "Label for this pocket"}
                      disabled={!canEdit || r.na}
                      aria-label={`Label for pocket ${r.index}`}
                      onChange={(e) => updateRow(r.key, { text: e.target.value })}
                    />
                    <label className="lbl-na">
                      <input
                        type="checkbox"
                        checked={r.na}
                        disabled={!canEdit}
                        aria-label={`No label for pocket ${r.index}`}
                        onChange={(e) => updateRow(r.key, { na: e.target.checked })}
                      />
                      N/A
                    </label>
                  </li>
                );
              })}
            </ul>

            {canEdit ? (
              <div style={{ marginTop: "1rem" }}>
                {submitState === "done" ? (
                  <p className="badge badge--approved" style={{ display: "inline-block", marginBottom: "0.6rem" }}>
                    Labels submitted{d.labels_submitted_by ? ` by ${d.labels_submitted_by}` : ""} — edits here update them
                  </p>
                ) : null}
                <div className="field">
                  <label htmlFor="signName">Your name</label>
                  <input
                    id="signName"
                    type="text"
                    autoComplete="name"
                    maxLength={200}
                    placeholder="e.g. Jordan Smith"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <button
                  className="btn btn--primary btn--block"
                  disabled={!complete || submitState === "busy"}
                  onClick={submit}
                >
                  {submitState === "busy" ? "Sending…" : submitState === "done" ? "Update submitted labels" : "Submit labels"}
                </button>
                <p className="muted" style={{ fontSize: "0.8rem", margin: "0.6rem 0 0" }}>
                  You can come back and edit these until we start cutting. Labels are engraved as typed.
                </p>
              </div>
            ) : null}
            <p className="err" role="alert">
              {error}
            </p>
          </>
        ) : dxfState === "loading" ? (
          <p className="muted">Loading pockets…</p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Tool-pocket extraction from tidyCAD DXF exports, for the customer label tool.
 *
 * Verified structure (Phase 0, 2026-08-03 — 17 prod files):
 *   - units inches ($INSUNITS=1)
 *   - layer BoundaryBox: 1 LWPOLYLINE = the drawer rectangle
 *   - layer Outline: one LWPOLYLINE per pocket. NOT flagged closed (group 70),
 *     but first/last vertices coincide — treat as closed by endpoints.
 *   - CIRCLE entities are round pockets
 *   - layer Labels: one TEXT "Object N" per pocket, inserted inside (or very
 *     near) its pocket. N is tidyCAD's numbering — we reuse it so the portal
 *     and tidyCAD agree. Legacy files may lack the Labels layer entirely;
 *     those pockets get sequential numbers by centroid order.
 *
 * Pure functions, no deps — parses only the entity types/codes we need.
 */

export type Pocket = {
  /** DXF entity handle — the stable per-file pocket key stored in drawer_label. */
  key: string;
  /** tidyCAD's "Object N" number (or a centroid-order fallback). 1-based. */
  index: number;
  /** Polygon vertices in DXF coords (inches, y-up). Circles are polygonized. */
  points: [number, number][];
  /** Centroid (mean of vertices) in DXF coords. */
  cx: number;
  cy: number;
};

export type PocketSet = {
  /** Drawer boundary bbox in DXF coords. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  pockets: Pocket[];
  /** True when the Labels layer supplied the numbering (modern exports). */
  numberedByDxf: boolean;
};

type RawEntity = {
  type: string;
  layer: string;
  handle: string;
  /** LWPOLYLINE vertices. */
  pts: [number, number][];
  /** CIRCLE / TEXT insert point. */
  x?: number;
  y?: number;
  r?: number;
  text?: string;
};

/** Parse the ENTITIES section into the few entity types the label tool needs. */
function parseEntities(dxf: string): RawEntity[] {
  const lines = dxf.split(/\r?\n/);
  // Find the ENTITIES section start.
  let i = 0;
  let inEntities = false;
  const out: RawEntity[] = [];
  let cur: RawEntity | null = null;
  let curX: number | null = null;

  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
    curX = null;
  };

  while (i + 1 < lines.length) {
    const code = parseInt(lines[i].trim(), 10);
    const value = lines[i + 1];
    i += 2;
    if (Number.isNaN(code)) continue;

    if (code === 0) {
      const v = value.trim();
      if (v === "SECTION") {
        // Next pair should be (2, <name>); peek without consuming oddly.
        inEntities = false;
      } else if (v === "ENDSEC") {
        flush();
        inEntities = false;
      } else if (inEntities) {
        flush();
        if (v === "LWPOLYLINE" || v === "CIRCLE" || v === "TEXT") {
          cur = { type: v, layer: "", handle: "", pts: [] };
        }
      }
      continue;
    }
    if (code === 2 && !inEntities && value.trim() === "ENTITIES") {
      inEntities = true;
      continue;
    }
    if (!cur) continue;

    const v = value.trim();
    switch (code) {
      case 5:
        cur.handle = v;
        break;
      case 8:
        cur.layer = v;
        break;
      case 1:
        if (cur.type === "TEXT") cur.text = v;
        break;
      case 10:
        if (cur.type === "LWPOLYLINE") curX = parseFloat(v);
        else cur.x = parseFloat(v);
        break;
      case 20:
        if (cur.type === "LWPOLYLINE") {
          if (curX !== null) {
            cur.pts.push([curX, parseFloat(v)]);
            curX = null;
          }
        } else {
          cur.y = parseFloat(v);
        }
        break;
      case 40:
        if (cur.type === "CIRCLE") cur.r = parseFloat(v);
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

function polygonContains(pt: [number, number], poly: [number, number][]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function circlePoints(cx: number, cy: number, r: number, n = 48): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * Extract the drawer boundary + numbered pockets from a tidyCAD DXF.
 * Returns null when the file has no usable geometry.
 */
export function extractPockets(dxf: string): PocketSet | null {
  const ents = parseEntities(dxf);

  const boundary = ents.find(
    (e) => e.type === "LWPOLYLINE" && e.layer === "BoundaryBox" && e.pts.length >= 4,
  );
  const outlines = ents.filter(
    (e) => e.type === "LWPOLYLINE" && e.layer === "Outline" && e.pts.length >= 3,
  );
  const circles = ents.filter(
    (e) => e.type === "CIRCLE" && e.x !== undefined && e.y !== undefined && (e.r ?? 0) > 0,
  );
  const labelTexts = ents.filter(
    (e) => e.type === "TEXT" && e.layer === "Labels" && e.text && e.x !== undefined,
  );

  // Candidate pockets: outline polylines + circles. Keys must be unique — a
  // duplicated key would corrupt the (drawer_id, pocket_key) upsert — so a
  // repeated/missing entity handle gets a positional suffix.
  type Cand = { key: string; points: [number, number][]; cx: number; cy: number; r?: number; x?: number; y?: number };
  const cands: Cand[] = [];
  const usedKeys = new Set<string>();
  const uniqueKey = (base: string) => {
    let k = base;
    for (let i = 2; usedKeys.has(k); i++) k = `${base}-${i}`;
    usedKeys.add(k);
    return k;
  };
  for (const o of outlines) {
    let cx = 0;
    let cy = 0;
    for (const [x, y] of o.pts) {
      cx += x;
      cy += y;
    }
    cands.push({ key: uniqueKey(o.handle || `poly-${cands.length}`), points: o.pts, cx: cx / o.pts.length, cy: cy / o.pts.length });
  }
  for (const c of circles) {
    cands.push({
      key: uniqueKey(c.handle || `circle-${cands.length}`),
      points: circlePoints(c.x as number, c.y as number, c.r as number),
      cx: c.x as number,
      cy: c.y as number,
      r: c.r,
      x: c.x,
      y: c.y,
    });
  }
  if (cands.length === 0) return null;

  // Bounds: prefer the BoundaryBox rectangle, else the extent of all pockets.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const boundPts = boundary ? boundary.pts : cands.flatMap((c) => c.points);
  for (const [x, y] of boundPts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;

  // Number pockets from the Labels layer: "Object N" insert point →
  // containing pocket (nearest-centroid fallback — one prod file needed it).
  // tidyCAD's numbering is NOT guaranteed unique (Top Drawer in prod has
  // "Object 12" twice and skips 10) — a repeated N leaves the second pocket
  // unnumbered here and the fallback below gives it an unused number.
  const assigned = new Map<string, number>(); // key -> index
  const taken = new Set<number>();
  let numberedByDxf = false;
  for (const t of labelTexts) {
    const m = /(\d+)\s*$/.exec(t.text as string);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!n || taken.has(n)) continue;
    const pt: [number, number] = [t.x as number, t.y as number];
    let hit = cands.find(
      (c) => !assigned.has(c.key) && (c.r !== undefined
        ? Math.hypot(pt[0] - (c.x as number), pt[1] - (c.y as number)) <= (c.r as number)
        : polygonContains(pt, c.points)),
    );
    if (!hit) {
      // Nearest unassigned pocket by centroid distance.
      let best: Cand | undefined;
      let bestD = Infinity;
      for (const c of cands) {
        if (assigned.has(c.key)) continue;
        const d = Math.hypot(pt[0] - c.cx, pt[1] - c.cy);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      hit = best;
    }
    if (hit) {
      assigned.set(hit.key, n);
      taken.add(n);
      numberedByDxf = true;
    }
  }

  // Fallback numbering for anything the Labels layer didn't cover: top-left →
  // bottom-right by centroid (DXF y-up, so "top" is max y).
  const unnumbered = cands.filter((c) => !assigned.has(c.key));
  unnumbered.sort((a, b) => (b.cy - a.cy) || (a.cx - b.cx));
  let next = 1;
  const used = new Set(assigned.values());
  for (const c of unnumbered) {
    while (used.has(next)) next++;
    assigned.set(c.key, next);
    used.add(next);
  }

  const pockets: Pocket[] = cands
    .map((c) => ({ key: c.key, index: assigned.get(c.key) as number, points: c.points, cx: c.cx, cy: c.cy }))
    .sort((a, b) => a.index - b.index);

  return { bounds: { minX, minY, maxX, maxY }, pockets, numberedByDxf };
}

/** Normalized [x,y] photo-space corners, TL,TR,BR,BL — tidyCAM's shape. */
export type CornerQuad = [number, number][];

/** Pull reference_corners out of drawer.dimensions (top level or .correction). */
export function referenceCorners(dimensions: unknown): CornerQuad | null {
  let d = dimensions;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (typeof d !== "object" || d === null) return null;
  const o = d as Record<string, unknown>;
  const raw =
    (o.reference_corners as unknown) ??
    ((o.correction as Record<string, unknown> | undefined)?.reference_corners as unknown);
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const quad: CornerQuad = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 2) return null;
    const x = Number(c[0]);
    const y = Number(c[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    quad.push([x, y]);
  }
  return quad;
}

/**
 * Map a DXF point into normalized photo space (0–1, y-down) by bilinear
 * interpolation over the reference-corner quad. u runs left→right across the
 * drawer, w runs top→bottom (DXF is y-up, photos are y-down, hence 1 - v).
 */
export function dxfToPhoto(
  x: number,
  y: number,
  bounds: PocketSet["bounds"],
  quad: CornerQuad,
): [number, number] {
  const u = (x - bounds.minX) / (bounds.maxX - bounds.minX);
  const w = 1 - (y - bounds.minY) / (bounds.maxY - bounds.minY);
  const [tl, tr, br, bl] = quad;
  const px =
    tl[0] * (1 - u) * (1 - w) + tr[0] * u * (1 - w) + br[0] * u * w + bl[0] * (1 - u) * w;
  const py =
    tl[1] * (1 - u) * (1 - w) + tr[1] * u * (1 - w) + br[1] * u * w + bl[1] * (1 - u) * w;
  return [px, py];
}

/** Categorical, colorblind-aware palette; cycles past 10. */
export const POCKET_COLORS = [
  "#4E79A7", "#F28E2B", "#59A14F", "#B07AA1", "#76B7B2",
  "#EDC94B", "#FF9DA7", "#9C755F", "#86BCB6", "#E15759",
] as const;

export function pocketColor(index: number): string {
  return POCKET_COLORS[(index - 1) % POCKET_COLORS.length];
}

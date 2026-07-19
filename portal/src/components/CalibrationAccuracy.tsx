"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { CalibrationPoint, CalibrationSummary } from "@/lib/types";

/**
 * Live per-scan calibration accuracy for the admin area.
 *
 * Design (dataviz method): the headline is a number → KPI tiles, not a chart.
 * The plot shows individual scans as MUTED dots (context) and a single ACCENT
 * rolling-average line (the signal), on ONE axis (accuracy %). Error (mm) never
 * shares that axis — it lives in the tiles. The 90% acceptance threshold is a
 * dashed GOOD-green line carrying a text label + an on-target badge (icon +
 * words, never colour alone). A "Show data table" view mirrors the chart.
 *
 * Data: get_calibration_accuracy_series (initial load) + Supabase Realtime on
 * the `drawer` table for live upserts. Only drawers scanned with the updated
 * tidyCAM app carry `dimensions.calibration_quality`, so this is empty until
 * new scans arrive — hence the labelled "sample data" preview toggle.
 */

const TARGET = 90; // acceptance threshold (%)
const ROLL = 7; // trailing points in the rolling average

// Mirror the design-system tokens in globals.css.
const MUTED = "#8a949c"; // raw scan dots — deliberately recessive (context)
const ACCENT = "#e8312a"; // rolling average — the one accented signal
const GOOD = "#1e7e45"; // target line + on-target status
const BORDER = "#dde3e8";
const GRID = "#eef1f4";
const INK = "#1e2a33";
const DIM = "#5b6870";

type P = {
  id: string;
  nickname: string | null;
  at: number;
  score: number;
  err: number | null;
};

function toPoints(rows: CalibrationPoint[]): P[] {
  return rows
    .map((r) => ({
      id: r.drawer_id,
      nickname: r.nickname,
      at: new Date(r.scanned_at).getTime(),
      score: Number(r.score),
      err: r.diagonal_error_mm == null ? null : Number(r.diagonal_error_mm),
    }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.score))
    .sort((a, b) => a.at - b.at);
}

function quantile(xs: number[], q: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function round1(x: number | null): string {
  return x == null ? "—" : (Math.round(x * 10) / 10).toLocaleString();
}

/** Deterministic-enough synthetic series for the empty-state preview. */
function sampleRows(): CalibrationPoint[] {
  const out: CalibrationPoint[] = [];
  const now = Date.now();
  const N = 46;
  for (let i = 0; i < N; i++) {
    const t = now - (N - 1 - i) * 36 * 3600 * 1000; // ~1.5-day spacing (~70 days)
    const trend = 84 + (i / (N - 1)) * 11; // drifts 84 → 95
    const noise = Math.sin(i * 1.7) * 2.1 + (Math.random() - 0.5) * 2.4;
    const score = Math.max(72, Math.min(99.4, trend + noise));
    const err = Math.max(0.4, (100 - score) / 6 + (Math.random() - 0.5) * 0.5);
    out.push({
      drawer_id: `sample-${i}`,
      nickname: `Sample drawer ${i + 1}`,
      scanned_at: new Date(t).toISOString(),
      score: Math.round(score * 10) / 10,
      diagonal_error_mm: Math.round(err * 10) / 10,
      edge_asymmetry_pct: null,
    });
  }
  return out;
}

export function CalibrationAccuracy({
  initialSeries,
  initialSummary,
}: {
  initialSeries: CalibrationPoint[];
  initialSummary: CalibrationSummary | null;
}) {
  const [rows, setRows] = useState<CalibrationPoint[]>(initialSeries);
  const [rangeDays, setRangeDays] = useState<number>(90);
  const [sample, setSample] = useState(false);
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const sampleData = useMemo(() => sampleRows(), []);
  const activeRows = sample ? sampleData : rows;

  // Realtime: upsert drawer rows that carry calibration_quality. Realtime
  // respects RLS, so a signed-in admin only receives rows they may read.
  useEffect(() => {
    if (sample) {
      setLive("off");
      return;
    }
    const supabase = createClient();
    const channel = supabase
      .channel("drawer-accuracy")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "drawer" },
        (payload) => {
          const row = (payload.new ?? {}) as Record<string, unknown>;
          let dims = row.dimensions as unknown;
          if (typeof dims === "string") {
            try {
              dims = JSON.parse(dims);
            } catch {
              dims = null;
            }
          }
          const q = (dims as { calibration_quality?: Record<string, unknown> } | null)
            ?.calibration_quality;
          if (!q || row.id == null) return;
          const num = (v: unknown) => (v == null ? null : Number(v));
          const point: CalibrationPoint = {
            drawer_id: String(row.id),
            nickname: (row.nickname as string | null) ?? null,
            scanned_at: row.created_at as string,
            score: num(q.score),
            diagonal_error_mm: num(q.diagonal_error_mm),
            edge_asymmetry_pct: num(q.edge_asymmetry_pct),
          };
          setRows((prev) => {
            const next = prev.filter((r) => r.drawer_id !== point.drawer_id);
            next.push(point);
            return next;
          });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setLive("live");
        else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        )
          setLive("off");
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [sample]);

  const all = useMemo(() => toPoints(activeRows), [activeRows]);

  // Points inside the selected window (client-side filter of the loaded series).
  const pts = useMemo(() => {
    const cutoff = Date.now() - rangeDays * 86400000;
    return all.filter((p) => p.at >= cutoff);
  }, [all, rangeDays]);

  // KPI tiles, computed from the live series (single source of truth). Falls
  // back to the server summary only when nothing has loaded yet.
  const kpi = useMemo(() => {
    const win = rangeDays * 86400000;
    const cutoff = Date.now() - win;
    const cur = all.filter((p) => p.at >= cutoff);
    const prev = all.filter((p) => p.at >= cutoff - win && p.at < cutoff);
    const avg = cur.length ? cur.reduce((s, p) => s + p.score, 0) / cur.length : null;
    const prevAvg = prev.length
      ? prev.reduce((s, p) => s + p.score, 0) / prev.length
      : null;
    const errs = cur.map((p) => p.err).filter((e): e is number => e != null);
    return {
      avg,
      delta: avg != null && prevAvg != null ? avg - prevAvg : null,
      medErr: quantile(errs, 0.5),
      p90Err: quantile(errs, 0.9),
      scans: cur.length,
      onTarget: avg != null ? avg >= TARGET : null,
    };
  }, [all, rangeDays]);

  const useSummary = !sample && all.length === 0 && initialSummary != null;

  // Rolling (trailing) average across the windowed points.
  const rolled = useMemo(
    () =>
      pts.map((p, i) => {
        const win = pts.slice(Math.max(0, i - (ROLL - 1)), i + 1);
        return { at: p.at, avg: win.reduce((s, q) => s + q.score, 0) / win.length };
      }),
    [pts],
  );

  // ---- chart geometry (single axis: accuracy %) ----
  const W = 820;
  const H = 340;
  const M = { top: 16, right: 18, bottom: 34, left: 40 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const geo = useMemo(() => {
    if (!pts.length) return null;
    const tMin = pts[0].at;
    const tMaxRaw = pts[pts.length - 1].at;
    const tMax = tMaxRaw === tMin ? tMin + 86400000 : tMaxRaw;
    const dataMin = Math.min(...pts.map((p) => p.score), TARGET);
    let yMin = Math.floor((dataMin - 4) / 5) * 5;
    yMin = Math.max(0, Math.min(yMin, 85));
    const yMax = 100;
    const x = (t: number) => M.left + ((t - tMin) / (tMax - tMin)) * iw;
    const y = (v: number) => M.top + (1 - (v - yMin) / (yMax - yMin)) * ih;
    const ticks: number[] = [];
    for (let v = yMin; v <= yMax + 0.001; v += 5) ticks.push(v);
    const dticks: number[] = [];
    const K = Math.min(5, pts.length);
    for (let i = 0; i < K; i++)
      dticks.push(tMin + ((tMax - tMin) * i) / Math.max(1, K - 1));
    return { tMin, tMax, yMin, yMax, x, y, ticks, dticks };
  }, [pts]);

  const rollPath =
    geo && rolled.length
      ? "M" + rolled.map((r) => `${geo.x(r.at)},${geo.y(r.avg)}`).join("L")
      : "";

  const onMove = (e: MouseEvent) => {
    if (!geo || !svgRef.current || !pts.length) return;
    const rect = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(geo.x(pts[i].at) - vx);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    setHover(best);
  };

  const hp = hover != null && pts[hover] ? pts[hover] : null;

  // ---- empty state ----
  if (!sample && all.length === 0) {
    return (
      <>
        <KpiRow kpi={kpi} rangeDays={rangeDays} summary={useSummary ? initialSummary : null} />
        <div className="card" style={{ marginTop: "1.1rem", textAlign: "center", padding: "2.2rem 1.25rem" }}>
          <h2 style={{ marginBottom: "0.3rem" }}>No calibration data yet</h2>
          <p className="muted" style={{ maxWidth: 520, margin: "0 auto 1rem" }}>
            This chart fills in automatically as scans come in from the updated
            tidyCAM app — each scan writes an accuracy score we plot here in real
            time. Nothing to do; it&apos;ll appear on its own.
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSample(true)}>
            Preview with sample data
          </button>
          <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.8rem" }}>
            Live status: {live === "live" ? "connected" : live === "connecting" ? "connecting…" : "polling off"}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      {sample ? (
        <p className="banner--ok" role="status" style={{ background: "#fff7e6", borderColor: "#f3cf9e", color: "#a85c12", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <span>Showing <strong>sample data</strong> — not real scans. This is a preview of the chart&apos;s look.</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSample(false)}>
            Back to live data
          </button>
        </p>
      ) : null}

      <KpiRow kpi={kpi} rangeDays={rangeDays} summary={null} />

      <div className="card" style={{ marginTop: "1.1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>Accuracy over time</h2>
            {!sample ? (
              <span className="chip" style={{ gap: "0.4rem" }}>
                <span
                  aria-hidden
                  style={{ width: 8, height: 8, borderRadius: 999, background: live === "live" ? GOOD : MUTED, display: "inline-block" }}
                />
                {live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Not live"}
              </span>
            ) : null}
          </div>
          <div className="admin-tabs" role="group" aria-label="Time range" style={{ marginTop: 0 }}>
            {[30, 90].map((d) => (
              <a
                key={d}
                href="#"
                aria-current={rangeDays === d ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setRangeDays(d);
                  setHover(null);
                }}
              >
                {d} days
              </a>
            ))}
          </div>
        </div>

        {/* Legend — always present for ≥2 series; identity never colour-alone. */}
        <div style={{ display: "flex", gap: "1.1rem", flexWrap: "wrap", fontSize: "0.82rem", color: DIM, marginBottom: "0.4rem" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontWeight: 600 }}>
            <svg width="14" height="14" aria-hidden><circle cx="7" cy="7" r="3" fill={MUTED} /></svg>
            Individual scan
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontWeight: 600 }}>
            <svg width="18" height="14" aria-hidden><line x1="1" y1="7" x2="17" y2="7" stroke={ACCENT} strokeWidth="2.5" /></svg>
            Rolling average
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontWeight: 600 }}>
            <svg width="18" height="14" aria-hidden><line x1="1" y1="7" x2="17" y2="7" stroke={GOOD} strokeWidth="2" strokeDasharray="4 3" /></svg>
            Target {TARGET}%
          </span>
        </div>

        {geo ? (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            style={{ height: "auto", display: "block", touchAction: "none" }}
            role="img"
            aria-label={`Calibration accuracy over the last ${rangeDays} days`}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* y gridlines + labels */}
            {geo.ticks.map((v) => (
              <g key={`y${v}`}>
                <line x1={M.left} x2={W - M.right} y1={geo.y(v)} y2={geo.y(v)} stroke={GRID} strokeWidth={1} />
                <text x={M.left - 8} y={geo.y(v) + 3} textAnchor="end" fontSize={10} fill={DIM}>{v}</text>
              </g>
            ))}
            {/* x date labels */}
            {geo.dticks.map((t, i) => (
              <text key={`x${i}`} x={geo.x(t)} y={H - M.bottom + 18} textAnchor="middle" fontSize={10} fill={DIM}>
                {fmtDate(t)}
              </text>
            ))}
            {/* target line (dashed good-green) + label */}
            <line x1={M.left} x2={W - M.right} y1={geo.y(TARGET)} y2={geo.y(TARGET)} stroke={GOOD} strokeWidth={2} strokeDasharray="5 4" />
            <text x={W - M.right} y={geo.y(TARGET) - 5} textAnchor="end" fontSize={10} fontWeight={700} fill={GOOD}>
              Target {TARGET}%
            </text>
            {/* rolling average — the accent signal */}
            {rollPath ? <path d={rollPath} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
            {/* individual scans — muted context dots */}
            {pts.map((p, i) => (
              <circle key={p.id} cx={geo.x(p.at)} cy={geo.y(p.score)} r={hover === i ? 4.5 : 3} fill={MUTED} fillOpacity={hover === i ? 1 : 0.7} />
            ))}
            {/* hover crosshair + tooltip */}
            {hp ? (
              <g pointerEvents="none">
                <line x1={geo.x(hp.at)} x2={geo.x(hp.at)} y1={M.top} y2={H - M.bottom} stroke={BORDER} strokeWidth={1} />
                <circle cx={geo.x(hp.at)} cy={geo.y(hp.score)} r={4.5} fill={ACCENT} stroke="#fff" strokeWidth={1.5} />
                {(() => {
                  const bx = Math.min(Math.max(geo.x(hp.at) - 78, 2), W - 158);
                  const by = Math.max(geo.y(hp.score) - 62, 4);
                  return (
                    <g transform={`translate(${bx},${by})`}>
                      <rect width={156} height={54} rx={8} fill="#fff" stroke={BORDER} />
                      <text x={10} y={18} fontSize={11} fontWeight={700} fill={INK}>{fmtDateTime(hp.at)}</text>
                      <text x={10} y={34} fontSize={11} fill={INK}>Accuracy: <tspan fontWeight={700}>{round1(hp.score)}%</tspan></text>
                      <text x={10} y={48} fontSize={11} fill={DIM}>Diag. error: {hp.err == null ? "—" : `${round1(hp.err)} mm`}</text>
                    </g>
                  );
                })()}
              </g>
            ) : null}
          </svg>
        ) : null}

        <details className="reveal" style={{ marginTop: "0.8rem" }} open={showTable} onToggle={(e) => setShowTable((e.target as HTMLDetailsElement).open)}>
          <summary>Show data table</summary>
          <div className="table" style={{ marginTop: "0.7rem" }}>
            <div className="trow trow--head" style={{ gridTemplateColumns: "1.6fr 1fr 1fr 1fr" }}>
              <span>Scan</span>
              <span className="tr-right">Accuracy</span>
              <span className="tr-right">Diag. error</span>
              <span className="tr-right">When</span>
            </div>
            {[...pts].reverse().map((p) => (
              <div key={p.id} className="trow" style={{ gridTemplateColumns: "1.6fr 1fr 1fr 1fr" }}>
                <span className="primary">{p.nickname ?? p.id.slice(0, 8)}</span>
                <span className="tr-right num">{round1(p.score)}%</span>
                <span className="tr-right num">{p.err == null ? "—" : `${round1(p.err)} mm`}</span>
                <span className="tr-right sub num">{fmtDate(p.at)}</span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </>
  );
}

/** KPI tile row — the headline is a number, so it gets tiles, not a chart. */
function KpiRow({
  kpi,
  rangeDays,
  summary,
}: {
  kpi: {
    avg: number | null;
    delta: number | null;
    medErr: number | null;
    p90Err: number | null;
    scans: number;
    onTarget: boolean | null;
  };
  rangeDays: number;
  summary: CalibrationSummary | null;
}): ReactNode {
  // Server-summary fallback only used before any series has loaded.
  const avg = kpi.avg ?? (summary ? Number(summary.avg_score) : null);
  const medErr = kpi.medErr ?? (summary ? Number(summary.median_error_mm) : null);
  const p90Err = kpi.p90Err ?? (summary ? Number(summary.p90_error_mm) : null);
  const scans = kpi.scans || (summary ? Number(summary.scans) : 0);
  const onTarget = kpi.onTarget ?? (avg != null ? avg >= TARGET : null);
  const tile = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div className="card" style={{ padding: "0.95rem 1.1rem" }}>
      <div style={{ fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.02em", color: DIM, textTransform: "uppercase" }}>{label}</div>
      <div className="num" style={{ fontSize: "2rem", fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.1, marginTop: "0.2rem" }}>{value}</div>
      {sub ? <div className="num" style={{ fontSize: "0.82rem", color: DIM, marginTop: "0.15rem" }}>{sub}</div> : null}
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.9rem", marginTop: "1.1rem" }}>
      {tile(
        `Avg accuracy · ${rangeDays}d`,
        avg == null ? "—" : `${round1(avg)}%`,
        kpi.delta == null ? (
          onTarget == null ? " " : null
        ) : (
          <span style={{ color: kpi.delta >= 0 ? GOOD : "#c0392b", fontWeight: 700 }}>
            {kpi.delta >= 0 ? "▲" : "▼"} {round1(Math.abs(kpi.delta))} pts vs prior {rangeDays}d
          </span>
        ),
      )}
      {tile(
        "Status",
        onTarget == null ? (
          "—"
        ) : onTarget ? (
          <span style={{ color: GOOD, fontSize: "1.4rem" }}>✓ On target</span>
        ) : (
          <span style={{ color: "#a85c12", fontSize: "1.4rem" }}>▼ Below target</span>
        ),
        `Threshold ${TARGET}%`,
      )}
      {tile("Median error", medErr == null ? "—" : `${round1(medErr)} mm`, p90Err == null ? " " : `p90 ${round1(p90Err)} mm`)}
      {tile("Scans", scans.toLocaleString(), `last ${rangeDays} days`)}
    </div>
  );
}

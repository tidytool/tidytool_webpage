"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { StatusPipelineData } from "@/lib/types";

/**
 * Order pipeline rollup for Admin → Pipeline, on the status backbone
 * (get_status_pipeline + Realtime on status_event).
 *
 * Design (house dataviz method, same as CalibrationAccuracy): headline numbers
 * are KPI tiles; the one chart is a horizontal stage bar where every bar is
 * MUTED except the single accent signal — orders awaiting the customer, the
 * revenue-blocking stage. Position and blockers are shown as SEPARATE facts
 * (a condition of the aggregation-semantics sign-off): the aging board pairs
 * each order's position with its blocker counts and delivered x/y completion.
 */

const MUTED = "#8a949c";
const ACCENT = "#e8312a";
const GOOD = "#1e7e45";
const DIM = "#5b6870";

function AgeBadge({ days }: { days: number }) {
  const cls = days > 14 ? "badge--warn" : days > 7 ? "badge--changes" : "badge--pending";
  return <span className={`badge ${cls} num`}>{days}d</span>;
}

export function StatusPipeline({ initial }: { initial: StatusPipelineData }) {
  const [data, setData] = useState<StatusPipelineData>(initial);
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime: any status_event insert → debounced re-pull of the rollup.
  useEffect(() => {
    const supabase = createClient();
    const refetch = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(async () => {
        const { data: fresh } = await supabase.rpc("get_status_pipeline");
        if (fresh) setData(fresh as StatusPipelineData);
      }, 800);
    };
    const channel = supabase
      .channel("status-pipeline")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "status_event" },
        refetch,
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setLive("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
          setLive("off");
      });
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      supabase.removeChannel(channel);
    };
  }, []);

  const activeOrders = useMemo(
    () => data.counts.reduce((s, c) => s + Number(c.n), 0),
    [data.counts],
  );
  const maxCount = useMemo(
    () => Math.max(1, ...data.counts.map((c) => Number(c.n))),
    [data.counts],
  );
  const stuck = useMemo(
    () => data.aging.filter((a) => a.days_in_status > 7).length,
    [data.aging],
  );

  const tile = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div className="card" style={{ padding: "0.95rem 1.1rem" }}>
      <div style={{ fontSize: "0.72rem", fontWeight: 600, letterSpacing: "0.02em", color: DIM, textTransform: "uppercase" }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: "2rem", fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.1, marginTop: "0.2rem" }}>
        {value}
      </div>
      {sub ? (
        <div className="num" style={{ fontSize: "0.82rem", color: DIM, marginTop: "0.15rem" }}>{sub}</div>
      ) : null}
    </div>
  );

  return (
    <>
      {/* KPI tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.9rem", marginTop: "1.1rem" }}>
        {tile("Active orders", activeOrders, `${stuck} stuck > 7 days`)}
        {tile(
          "Waiting on customer",
          <span style={{ color: data.blockers.drawers_awaiting_customer > 0 ? ACCENT : undefined }}>
            {data.blockers.drawers_awaiting_customer}
          </span>,
          "designs awaiting approval",
        )}
        {tile(
          "Rework / on hold",
          data.blockers.drawers_rework + data.blockers.drawers_on_hold,
          `${data.blockers.drawers_rework} rework · ${data.blockers.drawers_on_hold} hold`,
        )}
        {tile(
          "Median cycle",
          data.cycle.median_days == null ? "—" : `${Math.round(Number(data.cycle.median_days) * 10) / 10}d`,
          data.cycle.median_days == null
            ? "accrues from live events"
            : `${data.cycle.completed} delivered · ${data.cycle.window_days}d`,
        )}
      </div>

      {/* Stage bar — orders by position; the accent bar is the customer bottleneck */}
      <div className="card" style={{ marginTop: "0.9rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Orders by stage</h2>
          <span className="chip" style={{ gap: "0.4rem" }}>
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 999, display: "inline-block", background: live === "live" ? GOOD : MUTED }}
            />
            {live === "live" ? "Live" : live === "connecting" ? "Connecting…" : "Not live"}
          </span>
        </div>
        {data.counts.length === 0 ? (
          <p className="muted" style={{ margin: "0.8rem 0 0" }}>No active orders.</p>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "0.45rem 0.8rem", alignItems: "center", marginTop: "0.9rem" }}>
            {data.counts.map((c) => {
              const isSignal = c.status === "awaiting_approval";
              return (
                <div key={c.status} style={{ display: "contents" }}>
                  <span style={{ fontSize: "0.84rem", fontWeight: isSignal ? 700 : 600, color: isSignal ? ACCENT : DIM, whiteSpace: "nowrap" }}>
                    {c.label}
                  </span>
                  <div aria-hidden style={{ background: "var(--c-surface-2)", borderRadius: 6, height: "1.15rem", overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${(Number(c.n) / maxCount) * 100}%`,
                        minWidth: "2px",
                        height: "100%",
                        borderRadius: 6,
                        background: isSignal ? ACCENT : MUTED,
                        opacity: isSignal ? 1 : 0.55,
                      }}
                    />
                  </div>
                  <span className="num" style={{ fontSize: "0.88rem", fontWeight: 700 }}>{c.n}</span>
                </div>
              );
            })}
          </div>
        )}
        {/* drawer-level queue counts as quiet context */}
        {data.queue.length > 0 ? (
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", marginTop: "1rem" }}>
            {data.queue.map((q) => (
              <span key={q.stage} className="chip num">
                {q.label} <strong>{q.n}</strong>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Aging board — the "what's stuck and why" view */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2>Aging</h2>
        <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.9rem" }}>
          Every active order by time in its current stage — oldest first. Amber
          past 7 days, red past 14.
        </p>
        {data.aging.length === 0 ? (
          <p className="muted" style={{ marginTop: "0.8rem" }}>Nothing active.</p>
        ) : (
          <div className="table">
            <div className="trow trow--head" style={{ gridTemplateColumns: "1.6fr 1.1fr 1.1fr 0.8fr 0.6fr" }}>
              <span>Order</span>
              <span>Stage</span>
              <span>Blockers</span>
              <span className="tr-right">Delivered</span>
              <span className="tr-right">Age</span>
            </div>
            {data.aging.map((a) => (
              <a
                key={a.id}
                href={`/admin/orders/${a.id}`}
                className="trow"
                style={{ gridTemplateColumns: "1.6fr 1.1fr 1.1fr 0.8fr 0.6fr" }}
              >
                <span>
                  <span className="primary">{a.project_name ?? "Untitled order"}</span>
                  <span className="sub" style={{ display: "block" }}>{a.customer_name ?? "—"}</span>
                </span>
                <span className="hide-sm">
                  <span className="chip">{a.label}</span>{" "}
                  {a.overridden ? <span className="badge badge--changes">manual</span> : null}
                </span>
                <span className="hide-sm sub">
                  {a.blocked_on_customer > 0 ? (
                    <span style={{ color: ACCENT, fontWeight: 700 }}>
                      {a.blocked_on_customer} awaiting customer
                    </span>
                  ) : null}
                  {a.blocked_on_customer > 0 && a.blocked_internal > 0 ? " · " : ""}
                  {a.blocked_internal > 0 ? `${a.blocked_internal} rework/hold` : ""}
                  {a.blocked_on_customer === 0 && a.blocked_internal === 0 ? "—" : ""}
                </span>
                <span className="tr-right num hide-sm">
                  {a.drawer_delivered}/{a.drawer_total}
                </span>
                <span className="tr-right">
                  <AgeBadge days={Number(a.days_in_status)} />
                </span>
              </a>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

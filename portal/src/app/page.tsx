import { redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { OrderTracker } from "@/components/OrderTracker";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";
import {
  type MyDrawer,
  type MyLabelStatus,
  type OrderTrackerData,
  needsLabels,
} from "@/lib/types";

/**
 * Customer dashboard — a WORK QUEUE, not a status wall (2026-08 UX pass).
 * One row per drawer (photo · name · single status · action), grouped under a
 * compact per-order header + stepper. Rows needing label text sort first and
 * link straight to /labels/[id]. The customer approval step is gone from this
 * surface: submitting labels is the go-ahead (see migration
 * 20260804120000_label_submit_auto_approval).
 */

// ---------------------------------------------------------------------------
// Presentation helpers (server-side, pure)
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Customer-facing wording for the legacy drawer_status enum (fallback only). */
const CUSTOMER_STATUS: Record<string, string> = {
  backlogged_by_admin: "Received",
  created_by_user: "Scanned & measured",
  received_by_tidydesk: "Received",
  processed_by_tidydesk: "In design",
  approved_by_qualityctrl: "In production",
  received_by_fabricator: "In production",
};

/**
 * The longest " - "-separated name prefix shared by EVERY drawer in a group.
 * tidyCAM names drawers "Set Name - Drawer"; the shared part becomes the
 * order heading so rows can read just "Dial Indicators".
 */
function sharedPrefixTokens(names: (string | null)[]): string[] {
  if (names.length < 2 || names.some((n) => !n)) return [];
  const split = names.map((n) => (n as string).split(" - ").map((t) => t.trim()));
  let prefix = split[0].slice(0, -1); // never consume a full name
  for (const tokens of split.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < tokens.length - 1 && prefix[i] === tokens[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) return [];
  }
  return prefix;
}

function stripPrefix(name: string | null, prefix: string[]): string {
  if (!name) return "Drawer";
  if (prefix.length === 0) return name;
  const tokens = name.split(" - ").map((t) => t.trim());
  const rest = tokens.slice(prefix.length).join(" - ");
  return rest || name;
}

type RowKind = "needed" | "submitted" | "idle";

function rowKind(l: MyLabelStatus | undefined): RowKind {
  if (l && needsLabels(l)) return "needed";
  if (l?.labels_submitted_at && !l.locked) return "submitted";
  return "idle";
}

/** One customer-meaningful status for a non-actionable drawer. */
function idleStatus(d: MyDrawer, l: MyLabelStatus | undefined): string {
  const sort = l?.stage_sort;
  if (sort != null) {
    if (sort >= 110) return "Delivered";
    if (sort >= 100) return "Ready for delivery";
    if (sort >= 80) return "In production";
    if (sort >= 30) return "In design";
    if (sort >= 20) return "Scanned & measured";
    return "Received";
  }
  return (d.status && CUSTOMER_STATUS[d.status]) || "Received";
}

const KIND_ORDER: Record<RowKind, number> = { needed: 0, submitted: 1, idle: 2 };

// ---------------------------------------------------------------------------
// Row + group components (server components)
// ---------------------------------------------------------------------------

function PillIcon({ done }: { done: boolean }) {
  return done ? (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
      <path
        d="M4 7.2l2 2 4-4.4"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="1" y="1" width="12" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function Thumb({ d, dim }: { d: MyDrawer; dim: boolean }) {
  return d.photo_url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="drow__thumb"
      src={d.photo_url}
      alt=""
      loading="lazy"
      style={dim ? { opacity: 0.55 } : undefined}
    />
  ) : (
    <span className="drow__thumb" aria-hidden />
  );
}

function DrawerRow({
  d,
  l,
  prefix,
}: {
  d: MyDrawer;
  l: MyLabelStatus | undefined;
  prefix: string[];
}) {
  const kind = rowKind(l);
  const name = stripPrefix(d.nickname, prefix);

  if (kind === "idle") {
    return (
      <div className="drow drow--idle">
        <Thumb d={d} dim />
        <span className="drow__name">{name}</span>
        <span className="pill pill--idle">{idleStatus(d, l)}</span>
        <span className="drow__chev" aria-hidden />
      </div>
    );
  }
  return (
    <a className="drow" href={`/labels/${d.id}`}>
      <Thumb d={d} dim={false} />
      <span className="drow__name">{name}</span>
      {kind === "needed" ? (
        <span className="pill pill--needed">
          <PillIcon done={false} /> Labels needed
        </span>
      ) : (
        <span className="pill pill--done">
          <PillIcon done /> Labels submitted
        </span>
      )}
      <span className="drow__chev" aria-hidden>
        ›
      </span>
    </a>
  );
}

function OrderGroup({
  drawers,
  labels,
  tracker,
}: {
  drawers: MyDrawer[];
  labels: Map<string, MyLabelStatus>;
  tracker: OrderTrackerData | undefined;
}) {
  const prefix = sharedPrefixTokens(drawers.map((d) => d.nickname));
  const received = fmtDate(tracker?.steps?.[0]?.entered_at);
  const title =
    drawers[0]?.project_name ||
    (prefix.length ? prefix.join(" - ") : received ? `Order — received ${received}` : "Your order");
  const total = tracker?.completion?.total ?? drawers.length;
  const delivered = tracker?.completion?.delivered ?? 0;

  const sorted = [...drawers].sort(
    (a, b) => KIND_ORDER[rowKind(labels.get(a.id))] - KIND_ORDER[rowKind(labels.get(b.id))],
  );

  return (
    <section className="card ogroup">
      <div className="ogroup__head">
        <div className="ogroup__title">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <span className="ogroup__meta num">
            {prefix.length && received ? `Received ${received} · ` : ""}
            {total} drawer{total === 1 ? "" : "s"} · {delivered} of {total} delivered
          </span>
          {tracker?.exception?.state === "on_hold" ? (
            <span className="badge badge--warn">On hold</span>
          ) : null}
        </div>
        {tracker ? <OrderTracker t={tracker} /> : null}
      </div>
      <div className="ogroup__rows">
        {sorted.map((d) => (
          <DrawerRow key={d.id} d={d} l={labels.get(d.id)} prefix={prefix} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const claims = await getClaims();
  if (!claims) redirect("/login");
  const email = (claims.email as string | undefined) ?? undefined;

  const supabase = await createClient();
  const [{ data, error }, adminRes, labelRes] = await Promise.all([
    supabase.rpc("get_my_drawers"),
    supabase.rpc("is_admin"),
    supabase.rpc("get_my_label_status"),
  ]);
  const drawers = (data ?? []) as MyDrawer[];
  const isAdmin = adminRes.data === true;
  const labels = new Map<string, MyLabelStatus>(
    ((labelRes.error ? [] : labelRes.data ?? []) as MyLabelStatus[]).map((l) => [
      l.drawer_id,
      l,
    ]),
  );

  // The get_my_drawers RPC is staged in supabase/migrations and may not be applied yet.
  const migrationPending =
    error?.code === "PGRST202" || /function .* does not exist/i.test(error?.message ?? "");

  // Group drawers by order and fetch each order's stepper data. Tracker
  // failures degrade gracefully to a headerless group — never block the page.
  const byOrder = new Map<string, MyDrawer[]>();
  const loose: MyDrawer[] = [];
  for (const d of drawers) {
    if (d.order_id) {
      const arr = byOrder.get(d.order_id) ?? [];
      arr.push(d);
      byOrder.set(d.order_id, arr);
    } else {
      loose.push(d);
    }
  }
  const orderIds = [...byOrder.keys()];
  const trackers = new Map<string, OrderTrackerData>();
  if (orderIds.length > 0) {
    const results = await Promise.all(
      orderIds.map((id) => supabase.rpc("get_order_tracker", { p_order_id: id })),
    );
    results.forEach((res, i) => {
      if (!res.error && res.data) trackers.set(orderIds[i], res.data as OrderTrackerData);
    });
  }

  const neededCount = drawers.filter((d) => {
    const l = labels.get(d.id);
    return l ? needsLabels(l) : false;
  }).length;
  const submittedCount = drawers.filter((d) => !!labels.get(d.id)?.labels_submitted_at).length;

  return (
    <>
      <Header email={email} isAdmin={isAdmin} />
      <main className="wrap">
        <p className="eyebrow">Customer portal</p>
        <h1>Your orders</h1>
        <p className="muted">
          Track each drawer from scan to installation. Drawers marked{" "}
          <b>Labels needed</b> require your engraving text before we cut the foam.
        </p>

        {migrationPending ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>Almost ready</h2>
            <p className="muted" style={{ margin: 0 }}>
              Your account is set up, but the data connection isn&apos;t live yet.
              Apply the <code>get_my_drawers</code> migration in{" "}
              <code>portal/supabase/migrations/</code> to start seeing your drawers
              here.
            </p>
          </div>
        ) : drawers.length === 0 ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>No drawers yet</h2>
            <p className="muted" style={{ margin: 0 }}>
              We don&apos;t have any drawers tied to <strong>{email}</strong>{" "}
              yet. Once your drawers are scanned and in design, they will show up
              here.
            </p>
            <p className="muted" style={{ margin: "0.75rem 0 0" }}>
              Already ordered and expecting to see your drawers?{" "}
              <a
                href={`https://tally.so/r/rjW6Z5${email ? `?email=${encodeURIComponent(email)}` : ""}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Let us know
              </a>{" "}
              and we&apos;ll get it sorted.
            </p>
          </div>
        ) : (
          <>
            {neededCount > 0 ? (
              <div className="action-banner" role="status">
                <b className="num">
                  {neededCount} drawer{neededCount === 1 ? "" : "s"} need
                  {neededCount === 1 ? "s" : ""} labels
                </b>{" "}
                <span className="muted">
                  Enter the engraving text for each pocket — labels are engraved
                  before the foam is cut.
                </span>
              </div>
            ) : submittedCount > 0 ? (
              <div className="action-banner action-banner--done" role="status">
                <b>All labels submitted</b>{" "}
                <span className="muted">
                  We&apos;ll take it from here — labels can be revised until
                  production begins.
                </span>
              </div>
            ) : null}

            {orderIds.map((orderId) => (
              <OrderGroup
                key={orderId}
                drawers={byOrder.get(orderId) ?? []}
                labels={labels}
                tracker={trackers.get(orderId)}
              />
            ))}

            {loose.length > 0 ? (
              <section className="card ogroup">
                <div className="ogroup__head">
                  <div className="ogroup__title">
                    <h2 style={{ margin: 0 }}>Other drawers</h2>
                  </div>
                </div>
                <div className="ogroup__rows">
                  {loose.map((d) => (
                    <DrawerRow key={d.id} d={d} l={labels.get(d.id)} prefix={[]} />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}

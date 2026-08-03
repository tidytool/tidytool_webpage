/** Shapes returned by the Supabase RPCs the portal calls. Keep in sync with the SQL. */

export type ApprovalStatus = "pending" | "approved" | "changes_requested";

/** Row from get_my_drawers() — one card on the dashboard. */
export type MyDrawer = {
  id: string;
  nickname: string | null;
  status: string | null;
  customer_approval_status: ApprovalStatus;
  design_preview_url: string | null;
  photo_url: string | null;
  dimensions: unknown;
  order_id: string | null;
  project_name: string | null;
  created_at: string;
};

/** Row from get_drawer_approval(p_id) — the approval screen. */
export type DrawerApproval = {
  id: string;
  nickname: string | null;
  dimensions: unknown;
  design_preview_url: string | null;
  dxf_url: string | null;
  customer_approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_at: string | null;
};

/** Row from get_drawer_changelog(p_drawer_id) — the history timeline. */
export type DrawerEvent = {
  event_type:
    | "design_uploaded"
    | "design_revised"
    | "approved"
    | "changes_requested"
    | "delivered";
  revision: number | null;
  actor_name: string | null;
  actor_role: "customer" | "staff";
  note: string | null;
  preview_url: string | null;
  created_at: string;
};

/** Human-friendly labels for the internal drawer status enum. */
export const STATUS_LABELS: Record<string, string> = {
  backlogged_by_admin: "Queued",
  created_by_user: "Scan received",
  received_by_tidydesk: "Received",
  processed_by_tidydesk: "In design",
  approved_by_qualityctrl: "Approved",
  received_by_fabricator: "In fabrication",
};

/** Row from get_admin_pipeline() — admin view of every drawer. */
export type AdminPipelineRow = {
  drawer_id: string;
  nickname: string | null;
  status: string | null;
  customer_approval_status: ApprovalStatus;
  current_revision: number | null;
  approved_by: string | null;
  approved_at: string | null;
  order_id: string | null;
  project_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  created_at: string;
};

/** Row from get_admin_orphan_orders() — orders with no customer link (decision 5). */
export type AdminOrphanOrder = {
  order_id: string;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  project_name: string | null;
  drawer_count: number | null;
  /** Integer CENTS — divide by 100 for dollars. */
  total_price: number | null;
};

/** Row from get_admin_customers() — assign-order dropdown + customers page. */
export type AdminCustomer = {
  customer_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  organization_id: string | null;
  organization_name: string | null;
  order_count: number;
  has_login: boolean;
};

/** Row from get_admin_organizations(). */
export type AdminOrganization = {
  organization_id: string;
  name: string;
  customer_count: number;
  order_count: number;
};

/** Row from get_admin_orders(filters) — the admin orders list. */
export type AdminOrderRow = {
  order_id: string;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  project_name: string | null;
  location: string | null;
  notes: string | null;
  drawer_count: number | null;
  /** Integer CENTS. */
  total_price: number | null;
  customer_id: string | null;
  organization_id: string | null;
  organization_name: string | null;
  drawer_rows: number;
  /**
   * Drawer rows at stage "designed" or later (status_def sort_order >=
   * DESIGNED_SORT). Optional/absent until migration 20260802120000 is
   * applied — render a dash when undefined.
   */
  drawers_designed?: number;
};

/**
 * status_def.sort_order of the "designed" stage — the design-complete
 * threshold. Mirrors the `>= 40` in migration 20260802120000; keep in sync.
 */
export const DESIGNED_SORT = 40;

/**
 * Row from get_my_label_status() — per-drawer tool-label state for the
 * dashboard CTAs. Absent until migration 20260803120000 is applied.
 */
export type MyLabelStatus = {
  drawer_id: string;
  stage_sort: number | null;
  has_dxf: boolean;
  labels_submitted_at: string | null;
  locked: boolean;
};

/** True when the dashboard should show "Name your tools" for this drawer. */
export function needsLabels(s: MyLabelStatus): boolean {
  return (
    (s.stage_sort ?? 0) >= DESIGNED_SORT &&
    s.has_dxf &&
    !s.locked &&
    s.labels_submitted_at === null
  );
}

/** A box inside get_admin_order_detail() — a container of drawers that duplicates as a unit. */
export type AdminBox = {
  id: string;
  label: string;
  /** Physical copies of the whole box. */
  quantity: number;
  created_at: string;
};

/** Drawer entry inside get_admin_order_detail(). */
export type AdminDetailDrawer = {
  id: string;
  nickname: string | null;
  status: string | null;
  customer_approval_status: ApprovalStatus;
  current_revision: number | null;
  photo_url: string | null;
  point_cloud_url: string | null;
  design_preview_url: string | null;
  dxf_url: string | null;
  /** Parent box id, or null for a standalone tray. */
  box_id: string | null;
  /** Copies of this drawer within its parent. Physical count = box.quantity × this. */
  quantity: number;
  /**
   * Product tier (essential | professional | premium) — picks the $/sqft rate.
   * Optional/null until migration 20260730120000 is applied; treat missing as essential.
   */
  tier?: string | null;
  /**
   * Status-backbone lifecycle stage + its status_def label/sort_order.
   * Optional/null until migration 20260802120000 is applied; stage_sort >=
   * DESIGNED_SORT means design-complete.
   */
  stage?: string | null;
  stage_label?: string | null;
  stage_sort?: number | null;
  created_at: string;
};

/** Shape of get_admin_order_detail(p_order_id). */
export type AdminOrderDetail = {
  order: Record<string, unknown> & {
    id: string;
    created_at: string;
    customer_name: string | null;
    customer_email: string | null;
    customer_phone: string | null;
    project_name: string | null;
    location: string | null;
    notes: string | null;
    drawer_count: number | null;
    total_price: number | null;
    customer_id: string | null;
    site_address: string | null;
    round_trip_miles: number | null;
  };
  customer: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  organization: { id: string; name: string } | null;
  boxes: AdminBox[];
  drawers: AdminDetailDrawer[];
};

/** Row from admin_list_users() — the Employees page. */
export type AdminUserRow = {
  user_id: string;
  email: string;
  roles: string[];
  created_at: string;
  last_sign_in_at: string | null;
};

/** Row from get_admin_audit(). */
export type AdminAuditRow = {
  id: string;
  actor: string;
  action: string;
  table_name: string;
  row_id: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
};

/**
 * Row from get_calibration_accuracy_series(p_days) — one scan's calibration
 * quality, for the live accuracy plot. numeric columns arrive as numbers via
 * PostgREST, but coerce with Number() before arithmetic to be safe.
 */
export type CalibrationPoint = {
  drawer_id: string;
  nickname: string | null;
  scanned_at: string;
  score: number | null;
  diagonal_error_mm: number | null;
  edge_asymmetry_pct: number | null;
};

/** Row from get_calibration_accuracy_summary(p_days) — the KPI rollup. */
export type CalibrationSummary = {
  scans: number;
  avg_score: number | null;
  median_error_mm: number | null;
  p90_error_mm: number | null;
};

/** Integer cents → "$1,234.56" (total_price is CENTS everywhere). */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Human-readable quote number: "Q-0042". This exact string becomes the
 * QuickBooks Online estimate DocNumber (enable "Custom transaction numbers"
 * in QBO sales settings) — it is the cross-reference between a portal quote
 * and its QBO estimate, so never reformat it once quotes have shipped.
 * Null-tolerant: quotes created before migration 20260730000000 gain a number
 * on backfill, but the UI must not crash if the RPC omits it.
 */
export function formatQuoteNumber(n: number | null | undefined): string | null {
  if (n == null) return null;
  return `Q-${String(n).padStart(4, "0")}`;
}

export function formatDimensions(dim: unknown): string | null {
  if (!dim) return null;
  let d = dim;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (typeof d !== "object" || d === null) return null;
  const o = d as Record<string, unknown>;
  const units = o.units ? ` ${o.units}` : "";
  const w = o.width;
  const l = o.length ?? o.depth ?? o.height;
  if (w != null && l != null) return `${w} × ${l}${units}`;
  const parts = Object.keys(o).map((k) => `${k}: ${o[k]}`);
  return parts.length ? parts.join(" · ") : null;
}

/** One customer-facing line inside get_quotes_for_order(). */
export type AdminQuoteLine = {
  position: number;
  kind:
    | "measurement_design"
    | "product"
    | "upgrade"
    | "delivery_install"
    | "min_order_adjustment";
  description: string;
  drawer_id: string | null;
  qty: number | null;
  unit: string | null;
  unit_price_cents: number | null;
  /** Integer CENTS. */
  amount_cents: number;
  included: boolean;
  meta: Record<string, unknown>;
};

/**
 * Row from get_quotes_for_order(p_order_id). estimated_cost / gross_* /
 * cost_breakdown are INTERNAL — never render them on a customer-facing surface.
 */
export type AdminQuote = {
  id: string;
  created_at: string;
  /**
   * Sequential human-readable number (render via formatQuoteNumber → "Q-0042";
   * future QuickBooks DocNumber). Null only until migration 20260730000000 is
   * applied — treat as optional in the UI.
   */
  quote_number?: number | null;
  /** QuickBooks Online Estimate.Id once pushed via the (future) API sync. */
  qb_estimate_id?: string | null;
  /** When the QBO estimate was created/last synced. Set by the future qb-sync. */
  qb_synced_at?: string | null;
  /**
   * The inputs the quote was priced with (miles/hours/trips) plus, when the
   * generator's rate knobs were changed, `config_overrides` — non-empty means
   * this quote was custom-priced (render the "Custom rates" badge). Optional
   * until migration 20260801000000 adds it to get_quotes_for_order.
   */
  inputs?: ({ config_overrides?: Record<string, unknown> } & Record<string, unknown>) | null;
  status: "draft" | "sent" | "accepted" | "declined" | "expired" | "void";
  /** Integer CENTS. */
  subtotal_cents: number;
  /** Integer CENTS. Exact sum of the line items (to the cent). */
  total_cents: number;
  estimated_cost_cents: number;
  gross_profit_cents: number;
  gross_margin: number | null;
  margin_target: number;
  below_target: boolean;
  warnings: string[];
  unpriced_drawers: { id: string; nickname: string | null; reason: string }[];
  valid_until: string | null;
  notes: string | null;
  cost_breakdown: {
    mileage_cents: number;
    driving_labor_cents: number;
    scanning_labor_cents: number;
    install_labor_cents: number;
    total_cents: number;
    assumptions: {
      trips: number;
      round_trip_miles: number;
      drive_hours_per_trip: number;
      install_hours: number;
      scanning_hours: number;
      total_area_sqft: number;
    };
  };
  lines: AdminQuoteLine[];
};

/* ---------- Status backbone (20260727100000_status_backbone) ---------- */

/** One customer-facing step from get_order_tracker().steps — the pizza tracker. */
export type TrackerStep = {
  step: number;
  label: string;
  state: "done" | "current" | "todo";
  entered_at: string | null;
  /** true when the timestamp was reconstructed by the backfill, not measured. */
  inferred: boolean;
};

/** Shape of get_order_tracker(p_order_id). status = coalesce(manual, computed). */
export type OrderTrackerData = {
  order_id: string;
  project_name: string | null;
  status: string;
  current_step: number;
  exception: { state: "on_hold" | "cancelled"; since: string | null } | null;
  blockers: { awaiting_approval: number; rework: number; on_hold: number };
  completion: { delivered: number; total: number };
  delivery_scheduled_at: string | null;
  steps: TrackerStep[];
};

/** Row from get_work_queue() — the staff/tidyCAD outstanding-work view. */
export type WorkQueueRow = {
  drawer_id: string;
  nickname: string | null;
  photo_url: string | null;
  stage: string;
  stage_label: string;
  stage_changed_at: string | null;
  days_in_stage: number;
  state: "active" | "on_hold" | "rework" | "cancelled";
  state_reason: string | null;
  blocked_on: "us" | "customer" | "hold" | "none";
  order_id: string | null;
  project_name: string | null;
  customer_name: string | null;
  order_status: string | null;
  order_state: string | null;
};

/** Shape of get_status_pipeline(p_days) — the admin pipeline rollup. */
export type StatusPipelineData = {
  counts: {
    status: string;
    label: string;
    sort_order: number;
    customer_step: number | null;
    n: number;
  }[];
  blockers: {
    drawers_awaiting_customer: number;
    drawers_rework: number;
    drawers_on_hold: number;
    orders_on_hold: number;
    orders_overridden: number;
  };
  aging: {
    id: string;
    project_name: string | null;
    customer_name: string | null;
    status: string;
    label: string;
    overridden: boolean;
    status_changed_at: string | null;
    days_in_status: number;
    delivery_scheduled_at: string | null;
    drawer_total: number;
    drawer_delivered: number;
    blocked_on_customer: number;
    blocked_internal: number;
  }[];
  queue: { stage: string; label: string; sort_order: number; n: number }[];
  cycle: { window_days: number; completed: number; median_days: number | null };
};

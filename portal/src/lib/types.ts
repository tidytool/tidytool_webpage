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
  };
  customer: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  organization: { id: string; name: string } | null;
  drawers: AdminDetailDrawer[];
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

/** Integer cents → "$1,234.56" (total_price is CENTS everywhere). */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

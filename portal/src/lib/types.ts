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
  event_type: "design_uploaded" | "design_revised" | "approved" | "changes_requested";
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

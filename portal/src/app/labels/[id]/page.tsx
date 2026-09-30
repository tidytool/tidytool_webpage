import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { LabelEditor, type DrawerLabelsData } from "@/components/LabelEditor";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";
import { DrawerNav, type DrawerNavItem } from "@/components/DrawerNav";
import { orderTitle, stripPrefixWords } from "@/lib/order-title";
import type { MyDrawer, MyLabelStatus } from "@/lib/types";

/**
 * /labels/[id] — name the tools in one drawer, or (once the drawer is locked
 * for production / delivered) the read-only "Drawer layout": scan photo with
 * numbered pocket outlines for loading tools. Auth-required (unlike /approve,
 * there is no anonymous path). Data comes from get_drawer_labels (migration
 * 20260803120000); the DXF itself is fetched client-side.
 */
export default async function LabelsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const claims = await getClaims();
  if (!claims) redirect("/login");
  const email = (claims.email as string | undefined) ?? undefined;
  // Undefined (not "") when there's no full_name, so the editor can fall
  // back to the previous submitter's name on re-submit.
  const defaultName =
    ((claims.user_metadata as Record<string, unknown> | undefined)?.full_name as
      | string
      | undefined) || undefined;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_drawer_labels", { p_drawer_id: id });
  // The RPC is staged in supabase/migrations and may not be applied yet.
  const migrationPending =
    error?.code === "PGRST202" || /function .* does not exist/i.test(error?.message ?? "");
  if (!migrationPending && (error || !data)) notFound();

  const payload = data as DrawerLabelsData | null;
  const name = payload?.drawer.nickname || "Your TidyTool drawer";
  // Layout view when locked OR when the drawer has no engraved-label service (tier).
  const viewOnly = (payload?.drawer.locked ?? false) || payload?.drawer.labels_included === false;
  const layoutOnly = payload?.drawer.labels_included === false;

  // Sibling drawers in the same order, for prev/next + the back-to-order link.
  // Customers: get_my_drawers (RLS-free RPC). Staff opening a customer's
  // drawer: read the table directly (staff select policy).
  const nav = await siblingNav(supabase, id, !!payload?.drawer.is_staff);

  return (
    <>
      <Header email={email} />
      <main className="wrap wrap--wide">
        <DrawerNav
          currentId={id}
          orderHref={nav.orderId ? `/#order-${nav.orderId}` : "/"}
          orderTitle={nav.title}
          items={nav.items}
        />
        <p className="eyebrow">{viewOnly ? "Drawer layout" : "Tool labels"}</p>
        <h1>{nav.shortName ?? name}</h1>
        <p className="muted" style={{ maxWidth: "64ch" }}>
          {layoutOnly ? (
            <>Your scan photo with each pocket outlined — use it to see where each tool goes.</>
          ) : viewOnly ? (
            <>
              Your scan photo with each pocket outlined and numbered. Match the
              numbers to the list to see which tool goes where.
            </>
          ) : (
            <>
              Each pocket is numbered on the photo. Enter the text to engrave on that
              pocket&apos;s label, or mark <b>No label</b> for pockets that don&apos;t
              need one. Labels are engraved before the foam is cut.
            </>
          )}
        </p>

        {migrationPending ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>Almost ready</h2>
            <p className="muted" style={{ margin: 0 }}>
              Label entry isn&apos;t live yet. Apply the <code>customer_tool_labels</code> migration in{" "}
              <code>portal/supabase/migrations/</code> to enable it.
            </p>
          </div>
        ) : payload ? (
          <LabelEditor data={payload} defaultName={defaultName} />
        ) : null}
      </main>
    </>
  );
}

type SiblingNav = {
  orderId: string | null;
  title: string;
  /** This drawer's name minus the order's shared prefix (what the dashboard row shows). */
  shortName: string | null;
  items: DrawerNavItem[];
};

async function siblingNav(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  isStaff: boolean,
): Promise<SiblingNav> {
  const empty: SiblingNav = { orderId: null, title: "All orders", shortName: null, items: [] };
  try {
    const [{ data: mine }, { data: status }] = await Promise.all([
      supabase.rpc("get_my_drawers"),
      supabase.rpc("get_my_label_status"),
    ]);
    let drawers = ((mine ?? []) as MyDrawer[]).map((d) => ({
      id: d.id,
      nickname: d.nickname,
      order_id: d.order_id,
      photo_url: d.photo_url,
      project_name: d.project_name,
      dxf: false,
    }));
    const hasDxf = new Map(((status ?? []) as MyLabelStatus[]).map((l) => [l.drawer_id, l.has_dxf]));
    drawers = drawers.map((d) => ({ ...d, dxf: hasDxf.get(d.id) ?? false }));

    let me = drawers.find((d) => d.id === id);
    if (!me && isStaff) {
      const { data: row } = await supabase
        .from("drawer")
        .select("id, order_id")
        .eq("id", id)
        .maybeSingle();
      if (row?.order_id) {
        const { data: sibs } = await supabase
          .from("drawer")
          .select("id, nickname, order_id, photo_url, dxf_url, order:order_id(project_name)")
          .eq("order_id", row.order_id)
          .neq("state", "cancelled")
          .order("created_at");
        drawers = ((sibs ?? []) as unknown as {
          id: string;
          nickname: string | null;
          order_id: string;
          photo_url: string | null;
          dxf_url: string | null;
          order: { project_name: string | null } | null;
        }[]).map((d) => ({
          id: d.id,
          nickname: d.nickname,
          order_id: d.order_id,
          photo_url: d.photo_url,
          project_name: d.order?.project_name ?? null,
          dxf: !!d.dxf_url,
        }));
        me = drawers.find((d) => d.id === id);
      }
    }
    if (!me || !me.order_id) return empty;

    const inOrder = drawers.filter((d) => d.order_id === me!.order_id);
    const { title, prefixWords } = orderTitle({
      projectName: me.project_name,
      drawerNames: inOrder.map((d) => d.nickname),
    });
    // Only drawers that have a layout to show take part in prev/next.
    const items: DrawerNavItem[] = inOrder
      .filter((d) => d.id === id || (d.photo_url && d.dxf))
      .map((d) => ({ id: d.id, name: stripPrefixWords(d.nickname, prefixWords) }));
    return {
      orderId: me.order_id,
      title: title === "Your order" ? "All orders" : title,
      shortName: prefixWords ? stripPrefixWords(me.nickname, prefixWords) : null,
      items,
    };
  } catch {
    return empty;
  }
}

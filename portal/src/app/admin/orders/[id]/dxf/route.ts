import { zipSync, type Zippable } from "fflate";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { dxfPublicUrl, dxfZipEntryName } from "@/lib/dxf";
import type { AdminOrderDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /admin/orders/[id]/dxf — every DXF on the order, zipped.
 *
 * Route handlers do NOT inherit the admin layout's gate, so the same checks
 * are replicated here (claims -> 401, is_staff -> 403 — staff download DXFs
 * too); get_admin_order_detail then re-checks is_staff() inside the database
 * as defense in depth.
 *
 * Files are fetched with allSettled and zipped in memory: orders are tens of
 * drawers and DXFs are small text files, so streaming machinery isn't worth
 * its complexity. A drawer whose file can't be fetched (bad legacy URL) is
 * reported in _errors.txt instead of failing the whole download.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const claims = await getClaims();
  if (!claims) return new Response("Unauthorized", { status: 401 });
  const supabase = await createClient();
  const { data: isStaff, error: staffErr } = await supabase.rpc("is_staff");
  if (staffErr || !isStaff) return new Response("Forbidden", { status: 403 });

  const { data, error } = await supabase.rpc("get_admin_order_detail", {
    p_order_id: id,
  });
  if (error || !data) {
    return new Response(error?.message ?? "Order not found", { status: 404 });
  }
  const detail = data as AdminOrderDetail;

  // dxf_url is staff-written free text — only fetch from our own storage host.
  const allowedHost = new URL(SUPABASE_URL).host;
  const targets = detail.drawers.flatMap((d) => {
    const url = dxfPublicUrl(d.dxf_url);
    return url ? [{ id: d.id, nickname: d.nickname, url }] : [];
  });
  if (targets.length === 0) {
    return new Response("This order has no DXF files.", { status: 404 });
  }

  const used = new Set<string>();
  const entries: Zippable = {};
  const failures: string[] = [];

  const results = await Promise.allSettled(
    targets.map(async (t) => {
      if (new URL(t.url).host !== allowedHost) {
        throw new Error(`blocked non-storage host: ${new URL(t.url).host}`);
      }
      const res = await fetch(t.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
  results.forEach((r, i) => {
    const t = targets[i];
    if (r.status === "fulfilled") {
      entries[dxfZipEntryName(t.nickname, t.id, used)] = r.value;
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failures.push(`${t.nickname ?? t.id}: ${reason}`);
    }
  });

  if (Object.keys(entries).length === 0) {
    return new Response(
      `No DXF could be fetched:\n${failures.join("\n")}`,
      { status: 502 },
    );
  }
  if (failures.length > 0) {
    entries["_errors.txt"] = new TextEncoder().encode(
      `These drawers have a DXF recorded that could not be fetched:\n${failures.join("\n")}\n`,
    );
  }

  const zipped = zipSync(entries, { level: 6 });
  const project = (detail.order.project_name ?? id)
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .trim() || id;

  return new Response(new Uint8Array(zipped), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${project}-dxfs.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

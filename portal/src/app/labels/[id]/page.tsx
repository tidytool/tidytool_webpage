import { notFound, redirect } from "next/navigation";
import { Header } from "@/components/Header";
import { LabelEditor, type DrawerLabelsData } from "@/components/LabelEditor";
import { createClient } from "@/lib/supabase/server";
import { getClaims } from "@/lib/supabase/auth";

/**
 * /labels/[id] — name the tools in one drawer. Auth-required (unlike
 * /approve, there is no anonymous path). Data comes from get_drawer_labels
 * (migration 20260803120000); the DXF itself is fetched client-side.
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
  const defaultName =
    ((claims.user_metadata as Record<string, unknown> | undefined)?.full_name as
      | string
      | undefined) ?? "";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_drawer_labels", { p_drawer_id: id });
  // The RPC is staged in supabase/migrations and may not be applied yet.
  const migrationPending =
    error?.code === "PGRST202" || /function .* does not exist/i.test(error?.message ?? "");
  if (!migrationPending && (error || !data)) notFound();

  const payload = data as DrawerLabelsData | null;
  const name = payload?.drawer.nickname || "Your TidyTool drawer";

  return (
    <>
      <Header email={email} />
      <main className="wrap wrap--wide">
        <p style={{ margin: "0 0 1rem" }}>
          <a href="/" className="muted">
            ← All designs
          </a>
        </p>
        <p className="eyebrow">Tool labels</p>
        <h1>{name}</h1>
        <p className="muted" style={{ maxWidth: "64ch" }}>
          Match the <b>number and color</b> on the photo to the list and type what we should write on the label for each
          pocket. Check <b>N/A</b> for pockets that don&apos;t need one — we fill in the labels before we cut the foam.
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

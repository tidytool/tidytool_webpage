import { createClient } from "@/lib/supabase/server";
import { type AdminOrganization } from "@/lib/types";
import { createOrgAction } from "../actions";
import { OrganizationsList } from "@/components/OrganizationsList";

export const dynamic = "force-dynamic";

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_admin_organizations");
  const organizations = (data ?? []) as AdminOrganization[];

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Organizations</h1>
          <p className="muted sub num">
            {organizations.length} organization{organizations.length === 1 ? "" : "s"}.
            Customers are grouped under an org and see all of its orders in the portal.
          </p>
        </div>
      </div>

      {sp.error ? <p className="banner--err" role="alert">{sp.error}</p> : null}
      {error ? <p className="banner--err" role="alert">{error.message}</p> : null}

      <form action={createOrgAction} className="card" style={{ marginTop: "1.1rem" }}>
        <h2>New organization</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
          <input name="name" placeholder="Organization name" required style={{ flex: "1 1 240px", minWidth: 0, maxWidth: "420px" }} />
          <button className="btn btn--primary" type="submit">Create</button>
        </div>
      </form>

      {organizations.length === 0 ? (
        <p className="muted" style={{ marginTop: "1.2rem" }}>No organizations yet.</p>
      ) : (
        <OrganizationsList organizations={organizations} />
      )}
    </main>
  );
}

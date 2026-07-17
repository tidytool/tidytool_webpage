import { createClient } from "@/lib/supabase/server";
import { type AdminUserRow } from "@/lib/types";
import { EmployeesList } from "@/components/EmployeesList";

export const dynamic = "force-dynamic";

/**
 * Employees: who can sign in, and who has the 'staff' role that gates the
 * tidyCAD desktop work queue. The admin layout already redirects non-admins,
 * but the real boundary is admin_list_users() itself — it raises "admin only"
 * in the database, which we surface here as an access-denied state.
 */
export default async function AdminEmployeesPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_users");

  if (error && /admin only/i.test(error.message)) {
    return (
      <main className="wrap wrap--wide">
        <p className="banner--err" role="alert">
          Access denied — this page is for admins only.
        </p>
      </main>
    );
  }

  const users = (data ?? []) as AdminUserRow[];

  return (
    <main className="wrap wrap--wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Employees</h1>
          <p className="muted sub num">
            {users.length} account{users.length === 1 ? "" : "s"}. Staff can
            use the tidyCAD work queue; revoking removes that access
            immediately. Employees sign up for a portal account first (or get
            invited), then an admin grants staff here.
          </p>
        </div>
      </div>

      {error ? <p className="banner--err" role="alert">{error.message}</p> : null}

      <EmployeesList users={users} />
    </main>
  );
}

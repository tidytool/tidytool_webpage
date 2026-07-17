"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminUserRow } from "@/lib/types";
import {
  grantStaffRole,
  revokeStaffRole,
  inviteEmployeeAndGrantStaff,
} from "@/app/admin/actions";

const GRID = "minmax(200px, 2fr) minmax(120px, 1fr) 6.5rem 6.5rem 8.5rem";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Staff/admin first, then newest accounts first. */
function defaultSort(a: AdminUserRow, b: AdminUserRow): number {
  const rank = (u: AdminUserRow) =>
    u.roles.includes("admin") ? 0 : u.roles.includes("staff") ? 1 : 2;
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  return b.created_at.localeCompare(a.created_at);
}

/** One grant/revoke button per row. Admins get a disabled control with a
 *  tooltip — the RPC can't touch 'admin', and they already have staff powers. */
function StaffToggle({
  user,
  onDone,
  onError,
}: {
  user: AdminUserRow;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const isAdmin = user.roles.includes("admin");
  const isStaff = user.roles.includes("staff");

  if (isAdmin) {
    return (
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        disabled
        title="Admins already have all staff privileges; the admin role can't be changed here."
      >
        Admin
      </button>
    );
  }

  const run = () => {
    if (
      isStaff &&
      !window.confirm(
        `Revoke staff from ${user.email}?\n\n` +
          `They immediately lose access to the tidyCAD work queue.`,
      )
    ) {
      return;
    }
    startBusy(async () => {
      const res = isStaff
        ? await revokeStaffRole(user.email)
        : await grantStaffRole(user.email);
      if (res.error) onError(res.error);
      else {
        onDone(
          isStaff
            ? `Staff revoked from ${user.email}.`
            : `Staff granted to ${user.email}.`,
        );
        router.refresh();
      }
    });
  };

  return (
    <button
      type="button"
      className={`btn btn--sm ${isStaff ? "btn--danger" : "btn--ghost"}`}
      disabled={busy}
      onClick={run}
    >
      {busy ? "Saving…" : isStaff ? "Revoke staff" : "Grant staff"}
    </button>
  );
}

/** Employees table: search, staff-only filter, grant/revoke, grant-by-email. */
export function EmployeesList({ users }: { users: AdminUserRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [staffOnly, setStaffOnly] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Grant-by-email card
  const [grantEmail, setGrantEmail] = useState("");
  const [noAccount, setNoAccount] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();

  const onDone = (msg: string) => {
    setError(null);
    setNotice(msg);
  };
  const onError = (msg: string) => {
    setNotice(null);
    setError(msg);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => (q ? u.email.toLowerCase().includes(q) : true))
      .filter((u) => (staffOnly ? u.roles.length > 0 : true))
      .sort(defaultSort);
  }, [users, query, staffOnly]);

  const staffCount = users.filter((u) => u.roles.length > 0).length;

  const runGrantByEmail = () => {
    const addr = grantEmail.trim().toLowerCase();
    if (!addr) return;
    setNotice(null);
    setError(null);
    setNoAccount(null);
    startBusy(async () => {
      const res = await grantStaffRole(addr);
      if (res.error) {
        // "no auth user with that email" → they haven't signed up yet.
        if (/no auth user/i.test(res.error)) setNoAccount(addr);
        setError(res.error);
      } else {
        setGrantEmail("");
        onDone(`Staff granted to ${addr}.`);
        router.refresh();
      }
    });
  };

  const runInvite = () => {
    if (!noAccount) return;
    setNotice(null);
    setError(null);
    startBusy(async () => {
      const res = await inviteEmployeeAndGrantStaff(noAccount);
      if (res.error) setError(res.error);
      else {
        setNoAccount(null);
        setGrantEmail("");
        onDone(`Invite sent to ${noAccount} and staff granted.`);
        router.refresh();
      }
    });
  };

  return (
    <>
      <div className="card" style={{ marginTop: "1.1rem" }}>
        <h2>Grant staff by email</h2>
        <p className="muted" style={{ margin: "0.3rem 0 0", fontSize: "0.88rem" }}>
          For accounts not easily found in the list below. The person must
          already have a portal account.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
          <input
            type="email"
            value={grantEmail}
            onChange={(e) => {
              setGrantEmail(e.target.value);
              setNoAccount(null);
            }}
            placeholder="employee@example.com"
            aria-label="Email to grant staff access"
            style={{ flex: "1 1 220px", minWidth: 0 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runGrantByEmail();
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !grantEmail.trim()}
            onClick={runGrantByEmail}
          >
            {busy ? "Saving…" : "Grant staff"}
          </button>
        </div>
        {noAccount ? (
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.7rem" }}>
            <span className="muted" style={{ fontSize: "0.88rem" }}>
              That means {noAccount} hasn&apos;t created a portal account yet.
              They can sign up first, or:
            </span>
            <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={runInvite}>
              {busy ? "Sending…" : "Invite them & grant staff"}
            </button>
          </div>
        ) : null}
      </div>

      {notice ? <p className="banner--ok" role="status">{notice}</p> : null}
      {error ? <p className="banner--err" role="alert">{error}</p> : null}

      <div className="toolbar">
        <label className="ctrl" style={{ flex: "1 1 220px" }}>
          <span>Search by email</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter emails…"
            aria-label="Search users by email"
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", fontSize: "0.88rem", fontWeight: 600, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={staffOnly}
            onChange={(e) => setStaffOnly(e.target.checked)}
          />
          Staff &amp; admins only ({staffCount})
        </label>
      </div>

      <div className="table">
        <div className="trow trow--head" style={{ gridTemplateColumns: GRID }}>
          <span>Email</span>
          <span>Roles</span>
          <span>Created</span>
          <span className="hide-sm">Last sign-in</span>
          <span className="tr-right">Staff access</span>
        </div>
        {visible.length === 0 ? (
          <div className="trow" style={{ gridTemplateColumns: "1fr" }}>
            <span className="muted">
              {users.length === 0 ? "No users found." : "No users match this filter."}
            </span>
          </div>
        ) : (
          visible.map((u) => (
            <div key={u.user_id} className="trow" style={{ gridTemplateColumns: GRID }}>
              <span className="primary">{u.email}</span>
              <span>
                {u.roles.includes("admin") ? (
                  <span className="badge badge--changes">admin</span>
                ) : null}{" "}
                {u.roles.includes("staff") ? (
                  <span className="badge badge--approved">staff</span>
                ) : null}
                {u.roles.length === 0 ? (
                  <span className="sub">customer</span>
                ) : null}
              </span>
              <span className="sub num">{fmtDate(u.created_at)}</span>
              <span className="sub num hide-sm">{fmtDate(u.last_sign_in_at)}</span>
              <span className="tr-right">
                <StaffToggle user={u} onDone={onDone} onError={onError} />
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

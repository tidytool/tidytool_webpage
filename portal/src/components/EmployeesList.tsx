"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminUserRow } from "@/lib/types";
import { addEmployee, grantStaffRole, revokeStaffRole } from "@/app/admin/actions";

const GRID = "minmax(200px, 2fr) minmax(120px, 1fr) 6.5rem 6.5rem 8.5rem";

/** Mirrors the server-side check so the button only lights up for a sendable
 *  address; the server action re-validates regardless. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** One grant/revoke control per row. Revoking asks for an inline confirm —
 *  a second click on the same row — instead of a blocking window.confirm.
 *  Admins get a disabled control with a tooltip: the RPC can't touch 'admin',
 *  and they already have staff powers. */
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
  const [armed, setArmed] = useState(false);
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
    startBusy(async () => {
      const res = isStaff
        ? await revokeStaffRole(user.email)
        : await grantStaffRole(user.email);
      setArmed(false);
      if (res.error) onError(res.error);
      else {
        onDone(
          isStaff
            ? `Staff revoked from ${user.email} — their work-queue access is gone as of now.`
            : `Staff granted to ${user.email}.`,
        );
        router.refresh();
      }
    });
  };

  // Revoke is destructive-ish: arm on the first click, run on the second.
  if (isStaff && armed && !busy) {
    return (
      <span style={{ display: "inline-flex", gap: "0.3rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          onClick={run}
          title={`Revoke staff from ${user.email}. They immediately lose the tidyCAD work queue.`}
        >
          Confirm
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => setArmed(false)}
          aria-label="Cancel revoking staff"
        >
          ✕
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`btn btn--sm ${isStaff ? "btn--danger" : "btn--ghost"}`}
      disabled={busy}
      onClick={() => (isStaff ? setArmed(true) : run())}
    >
      {busy ? "Saving…" : isStaff ? "Revoke staff" : "Grant staff"}
    </button>
  );
}

/** Employees table: add-employee card, search, staff-only filter, grant/revoke. */
export function EmployeesList({ users }: { users: AdminUserRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [staffOnly, setStaffOnly] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-employee card
  const [addEmail, setAddEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, startBusy] = useTransition();

  // Success notices announce themselves and get out of the way; errors stay
  // until the next action resolves them.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

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

  const addr = addEmail.trim().toLowerCase();
  const addrValid = EMAIL_RE.test(addr);

  const runAdd = () => {
    if (!addrValid || busy) return;
    setNotice(null);
    setError(null);
    startBusy(async () => {
      const res = await addEmployee(addr);
      setConfirming(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      setAddEmail("");
      onDone(
        res.invited
          ? `Invite sent to ${addr}. They'll get an email to set a password — staff access is already in place.`
          : `${addr} already had an account — staff access granted.`,
      );
      router.refresh();
    });
  };

  return (
    <>
      <div className="card" style={{ marginTop: "1.1rem" }}>
        <h2>Add employee</h2>
        <p className="muted" style={{ margin: "0.3rem 0 0", fontSize: "0.88rem" }}>
          Grants staff access right away. No portal account yet? They&apos;ll
          get an email invite to set a password.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.7rem" }}>
          <input
            type="email"
            value={addEmail}
            onChange={(e) => {
              setAddEmail(e.target.value);
              setConfirming(false);
            }}
            placeholder="employee@example.com"
            aria-label="Email of the employee to add"
            style={{ flex: "1 1 220px", minWidth: 0 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && addrValid) {
                e.preventDefault();
                if (confirming) runAdd();
                else setConfirming(true);
              }
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !addrValid || confirming}
            title={addr && !addrValid ? "That doesn't look like an email address yet." : undefined}
            onClick={() => setConfirming(true)}
          >
            Add employee
          </button>
        </div>
        {confirming ? (
          <div
            style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.7rem" }}
            aria-live="polite"
          >
            <span style={{ fontSize: "0.9rem" }}>
              Add <strong>{addr}</strong> as an employee?
            </span>
            <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={runAdd}>
              {busy ? "Adding…" : "Yes, add them"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
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

"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminUserRow } from "@/lib/types";
import {
  addEmployee,
  grantStaffRole,
  revokeStaffRole,
  grantAdminRole,
  revokeAdminRole,
  setEmployeePassword,
} from "@/app/admin/actions";

const GRID = "minmax(200px, 2fr) minmax(110px, 1fr) 6.5rem 6.5rem 12.5rem";

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

/** Admins first, then staff, then newest accounts first. */
function defaultSort(a: AdminUserRow, b: AdminUserRow): number {
  const rank = (u: AdminUserRow) =>
    u.roles.includes("admin") ? 0 : u.roles.includes("staff") ? 1 : 2;
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  return b.created_at.localeCompare(a.created_at);
}

/** Readable random password the admin can relay (no confusable characters). */
function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

type Armed = null | "revoke-staff" | "revoke-admin" | "make-admin";

/** One employee row: role badges, access controls with inline confirms, and a
 *  fold-out set-password panel. Destructive or high-power changes (revoke
 *  staff, revoke admin, make admin) arm on the first click and run on the
 *  second — no blocking dialogs. */
function EmployeeRow({
  user,
  selfEmail,
  lastAdmin,
  onDone,
  onError,
}: {
  user: AdminUserRow;
  selfEmail: string;
  /** True when this row is an admin and no other admin exists. */
  lastAdmin: boolean;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [armed, setArmed] = useState<Armed>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");

  const isAdmin = user.roles.includes("admin");
  const isStaff = user.roles.includes("staff");
  const isSelf = user.email.toLowerCase() === selfEmail;
  const invitePending = !!user.invited_at && !user.last_sign_in_at;

  const run = (fn: () => Promise<{ error?: string; ok?: boolean }>, doneMsg: string) => {
    startBusy(async () => {
      const res = await fn();
      setArmed(null);
      if (res.error) onError(res.error);
      else {
        onDone(doneMsg);
        router.refresh();
      }
    });
  };

  const savePassword = () => {
    if (pw.length < 8 || busy) return;
    startBusy(async () => {
      const res = await setEmployeePassword(user.email, pw);
      if (res.error) onError(res.error);
      else {
        setPwOpen(false);
        setPw("");
        onDone(
          `Password set for ${user.email}. Hand it to them directly — they can change it any time with “Email me a link” on the sign-in page.`,
        );
      }
    });
  };

  const confirmPair = (label: string, title: string, action: () => void) => (
    <span style={{ display: "inline-flex", gap: "0.3rem", justifyContent: "flex-end" }}>
      <button type="button" className="btn btn--sm btn--danger" title={title} onClick={action}>
        {label}
      </button>
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() => setArmed(null)}
        aria-label="Cancel"
      >
        ✕
      </button>
    </span>
  );

  return (
    <>
      <div className="trow" style={{ gridTemplateColumns: GRID }}>
        <span className="primary" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          {user.email}
          {isSelf ? <span className="sub"> (you)</span> : null}
        </span>
        <span>
          {isAdmin ? <span className="badge badge--changes">admin</span> : null}{" "}
          {isStaff ? <span className="badge badge--approved">staff</span> : null}{" "}
          {invitePending ? (
            <span className="badge badge--pending" title={`Invited ${fmtDate(user.invited_at)}, hasn't signed in yet.`}>
              invite pending
            </span>
          ) : null}
        </span>
        <span className="sub num">{fmtDate(user.created_at)}</span>
        <span className="sub num hide-sm">{fmtDate(user.last_sign_in_at)}</span>
        <span
          className="tr-right"
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", alignItems: "flex-end" }}
        >
          {busy ? (
            <button type="button" className="btn btn--sm btn--ghost" disabled>
              Saving…
            </button>
          ) : isAdmin ? (
            armed === "revoke-admin" ? (
              confirmPair(
                isSelf ? "Confirm (this is you)" : "Confirm",
                isSelf
                  ? "Removes YOUR admin access — you'll lose this page immediately."
                  : `Removes admin from ${user.email}.`,
                () =>
                  run(
                    () => revokeAdminRole(user.email),
                    `Admin revoked from ${user.email}.`,
                  ),
              )
            ) : (
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={lastAdmin}
                title={
                  lastAdmin
                    ? "This is the only admin — grant admin to someone else first."
                    : undefined
                }
                onClick={() => setArmed("revoke-admin")}
              >
                Revoke admin
              </button>
            )
          ) : (
            <>
              {armed === "revoke-staff" ? (
                confirmPair(
                  "Confirm",
                  `They immediately lose the tidyCAD work queue and order views.`,
                  () =>
                    run(
                      () => revokeStaffRole(user.email),
                      `Staff revoked from ${user.email} — access is gone as of now.`,
                    ),
                )
              ) : armed === "make-admin" ? (
                confirmPair(
                  "Confirm",
                  `Full access: customers, employees, roles, and this page.`,
                  () =>
                    run(
                      () => grantAdminRole(user.email),
                      `${user.email} is now an admin.`,
                    ),
                )
              ) : (
                <>
                  <button
                    type="button"
                    className={`btn btn--sm ${isStaff ? "btn--danger" : "btn--ghost"}`}
                    onClick={() =>
                      isStaff
                        ? setArmed("revoke-staff")
                        : run(
                            () => grantStaffRole(user.email),
                            `Staff granted to ${user.email}.`,
                          )
                    }
                  >
                    {isStaff ? "Revoke staff" : "Grant staff"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    title="Give full admin access (includes this page)."
                    onClick={() => setArmed("make-admin")}
                  >
                    Make admin
                  </button>
                </>
              )}
            </>
          )}
          {!busy && armed === null ? (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              aria-expanded={pwOpen}
              onClick={() => {
                setPwOpen((v) => !v);
                setPw("");
              }}
            >
              {pwOpen ? "Close password" : "Set password"}
            </button>
          ) : null}
        </span>
      </div>
      {pwOpen ? (
        <div className="trow" style={{ gridTemplateColumns: "1fr" }}>
          <span
            style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" }}
          >
            <span className="muted" style={{ fontSize: "0.85rem", marginRight: "auto" }}>
              New password for <strong>{user.email}</strong> — you hand it over; no email is sent.
            </span>
            <input
              type="text"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="At least 8 characters"
              aria-label={`New password for ${user.email}`}
              spellCheck={false}
              autoComplete="off"
              style={{ flex: "0 1 220px", minWidth: 0, fontFamily: "monospace" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") savePassword();
              }}
            />
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => setPw(generatePassword())}
            >
              Generate
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={busy || pw.length < 8}
              title={pw && pw.length < 8 ? "At least 8 characters." : undefined}
              onClick={savePassword}
            >
              {busy ? "Saving…" : "Set password"}
            </button>
          </span>
        </div>
      ) : null}
    </>
  );
}

/** Employees table: add-employee card, search, role management (staff +
 *  admin), invite-pending badges, and direct password set/reset. Lists
 *  employees only — customers live on the Customers tab. */
export function EmployeesList({
  users,
  selfEmail,
}: {
  users: AdminUserRow[];
  selfEmail: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
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
    const t = setTimeout(() => setNotice(null), 8000);
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
      .sort(defaultSort);
  }, [users, query]);

  const adminCount = users.filter((u) => u.roles.includes("admin")).length;

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
            aria-label="Search employees by email"
          />
        </label>
      </div>

      <div className="table">
        <div className="trow trow--head" style={{ gridTemplateColumns: GRID }}>
          <span>Email</span>
          <span>Roles</span>
          <span>Created</span>
          <span className="hide-sm">Last sign-in</span>
          <span className="tr-right">Access</span>
        </div>
        {visible.length === 0 ? (
          <div className="trow" style={{ gridTemplateColumns: "1fr" }}>
            <span className="muted">
              {users.length === 0
                ? "No employees yet — add the first one above."
                : "No employees match this search."}
            </span>
          </div>
        ) : (
          visible.map((u) => (
            <EmployeeRow
              key={u.user_id}
              user={u}
              selfEmail={selfEmail}
              lastAdmin={u.roles.includes("admin") && adminCount <= 1}
              onDone={onDone}
              onError={onError}
            />
          ))
        )}
      </div>
    </>
  );
}

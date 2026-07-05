"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  invitePortalUser,
  createPortalLoginWithPassword,
} from "@/app/admin/actions";

/** Readable random password: no ambiguous chars (0/O, 1/l/I). */
function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(14);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

/** Invite-to-portal controls for one customer row (admin Customers tab).
 *  Primary: invite email → customer sets their own password.
 *  Fallback: set a password here and relay it to the customer yourself. */
export function PortalAccess({
  email,
  hasLogin,
  onError,
}: {
  email: string | null;
  hasLogin: boolean;
  onError: (msg: string | null) => void;
}) {
  const router = useRouter();
  const [invited, setInvited] = useState(false);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const [pwSet, setPwSet] = useState(false);
  const [busy, startBusy] = useTransition();

  if (!email) {
    return (
      <span className="muted" style={{ fontSize: "0.82rem" }}>
        Add an email to enable portal access.
      </span>
    );
  }

  const invite = () => {
    onError(null);
    startBusy(async () => {
      const res = await invitePortalUser(email);
      if (res.error) onError(res.error);
      else {
        setInvited(true);
        router.refresh();
      }
    });
  };

  const setPw = () => {
    onError(null);
    startBusy(async () => {
      const res = await createPortalLoginWithPassword(email, password);
      if (res.error) onError(res.error);
      else {
        setPwSet(true);
        router.refresh();
      }
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the field is selectable */
    }
  };

  return (
    <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
      {!hasLogin ? (
        invited ? (
          <span className="badge badge--approved">Invite sent to {email}</span>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            onClick={invite}
          >
            {busy ? "Sending…" : "Invite to portal"}
          </button>
        )
      ) : null}

      <details className="reveal">
        <summary>{hasLogin ? "Reset their password" : "Set a password instead"}</summary>
        {pwSet ? (
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.88rem" }}>
            Password set for <strong>{email}</strong>. Send it to them yourself —
            it is not emailed.
          </p>
        ) : (
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 8 chars)"
              autoComplete="off"
              spellCheck={false}
              style={{ flex: "1 1 170px", minWidth: 0, fontFamily: "monospace" }}
              aria-label={`Password for ${email}`}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPassword(generatePassword())}
            >
              Generate
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={copy}
              disabled={!password}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={setPw}
              disabled={busy || password.length < 8}
            >
              {busy ? "Saving…" : hasLogin ? "Reset password" : "Create login"}
            </button>
            <p className="muted" style={{ flexBasis: "100%", margin: 0, fontSize: "0.8rem" }}>
              Copy it before saving — you relay it to the customer; it is never emailed.
            </p>
          </div>
        )}
      </details>
    </div>
  );
}

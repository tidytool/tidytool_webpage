"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { type ApprovalStatus } from "@/lib/types";

type Props = {
  drawerId: string;
  status: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  defaultName?: string;
};

export function ApprovalForm({
  drawerId,
  status,
  approvedBy,
  approvedAt,
  defaultName = "",
}: Props) {
  const router = useRouter();
  const [name, setName] = useState(approvedBy ?? defaultName);
  const [showChanges, setShowChanges] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Already signed off — show the confirmation state instead of the form.
  if (status === "approved") {
    const when = approvedAt
      ? new Date(approvedAt).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;
    return (
      <div className="card" style={{ marginTop: "1.5rem", textAlign: "center" }}>
        <div style={{ fontSize: "2.2rem" }}>✅</div>
        <h2 style={{ fontSize: "1.2rem" }}>Design approved</h2>
        <p className="muted" style={{ margin: 0 }}>
          {approvedBy ? `Signed by ${approvedBy}` : "Approved"}
          {when ? ` on ${when}` : ""}. We&apos;ll start fabrication.
        </p>
      </div>
    );
  }

  async function submit(decision: ApprovalStatus) {
    setError("");
    const nm = name.trim();
    if (!nm) {
      setError("Please enter your name first.");
      return;
    }
    if (decision === "changes_requested" && !note.trim()) {
      setError("Please tell us what needs to change.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("submit_drawer_approval", {
      p_id: drawerId,
      p_name: nm,
      p_decision: decision,
      p_note: decision === "changes_requested" ? note.trim() : null,
    });
    setBusy(false);
    if (error) {
      setError(error.message || "Something went wrong. Please try again.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="card" style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.2rem" }}>Sign off on this design</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Your name and the time are recorded as your authorization to manufacture.
      </p>

      {status === "changes_requested" ? (
        <p style={{ color: "var(--c-accent)", fontWeight: 600 }}>
          You previously requested changes. Review the updated layout above and
          approve when it looks right.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="signName">Your name</label>
        <input
          id="signName"
          type="text"
          autoComplete="name"
          placeholder="e.g. Jordan Smith"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <button
          className="btn btn--primary btn--block"
          disabled={busy}
          onClick={() => submit("approved")}
        >
          {busy ? "Sending…" : "Approve this design"}
        </button>
        <button
          className="btn btn--ghost btn--block"
          type="button"
          disabled={busy}
          onClick={() => setShowChanges((v) => !v)}
        >
          {showChanges ? "Never mind — go back" : "Request changes instead"}
        </button>
      </div>

      {showChanges ? (
        <div style={{ marginTop: "1rem" }}>
          <div className="field">
            <label htmlFor="changeNote">What needs to change?</label>
            <textarea
              id="changeNote"
              placeholder="Tell us what to adjust…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button
            className="btn btn--primary btn--block"
            disabled={busy}
            onClick={() => submit("changes_requested")}
          >
            {busy ? "Sending…" : "Send change request"}
          </button>
        </div>
      ) : null}

      <p className="err" role="alert">
        {error}
      </p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";

/**
 * Set-password screen. Reached after a customer follows a one-time link
 * (dashboard invite, or "first time / forgot password" recovery from /login).
 * The link establishes the session in /auth/confirm; here we set a password so
 * the customer can sign in with email + password from then on.
 */
export default function SetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      // A common cause: the link expired before reaching this screen.
      setError(
        /session|jwt|expired|missing/i.test(error.message)
          ? "Your link expired. Head back to sign in and request a new one."
          : error.message,
      );
      return;
    }
    // Full reload so server components pick up the fresh session.
    window.location.assign("/");
  }

  return (
    <>
      <Header />
      <main className="wrap" style={{ maxWidth: 460 }}>
        <p className="eyebrow">Customer Portal</p>
        <h1>Set your password</h1>
        <p className="muted">
          Choose a password for your account. You&apos;ll use it with your email
          to sign in from now on.
        </p>

        <form className="card" style={{ marginTop: "1.25rem" }} onSubmit={save}>
          <div className="field">
            <label htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="confirm">Confirm password</label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <button className="btn btn--primary btn--block" disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </button>
          <p className="err" role="alert">
            {error}
          </p>
        </form>
      </main>
    </>
  );
}

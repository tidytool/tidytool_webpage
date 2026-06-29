"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Surface a failed/expired sign-in link (the /auth/confirm route redirects here).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "link") {
      setError("That link was invalid or expired. Sign in below, or request a new link.");
    }
  }, []);

  function siteUrl() {
    return process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
  }

  // Primary path: email + password.
  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const addr = email.trim();
    if (!addr || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: addr,
      password,
    });
    setBusy(false);
    if (error) {
      setError(
        "That email or password didn't match. First time here? Use the link below to set your password.",
      );
      return;
    }
    // Full reload so server components pick up the fresh session.
    window.location.assign("/");
  }

  // First-time setup OR forgot password: email a one-time link. This sends a
  // recovery email (works for pre-provisioned, invite-only accounts) that lands
  // the customer on /set-password. It never creates a new account.
  async function emailLink() {
    setError("");
    const addr = email.trim();
    if (!addr) {
      setError("Enter your email first, then request a link.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(addr, {
      redirectTo: `${siteUrl()}/auth/confirm?next=/set-password`,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  return (
    <>
      <Header />
      <main className="wrap" style={{ maxWidth: 460 }}>
        <p className="eyebrow">Customer Portal</p>
        <h1>Sign in</h1>
        <p className="muted">
          Use the email on your TidyTool order and your password. First time
          here? Set a password with the link below.
        </p>

        {sent ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>Check your email</h2>
            <p className="muted" style={{ margin: 0 }}>
              We sent a link to <strong>{email}</strong>. Open it on this device
              to set your password and sign in.
            </p>
          </div>
        ) : (
          <form className="card" style={{ marginTop: "1.25rem" }} onSubmit={signIn}>
            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button className="btn btn--primary btn--block" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="err" role="alert">
              {error}
            </p>
            <p className="muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.9rem" }}>
              First time here, or forgot your password?{" "}
              <button
                type="button"
                onClick={emailLink}
                disabled={busy}
                className="linkbtn"
              >
                Email me a link
              </button>
            </p>
          </form>
        )}

        <p className="muted" style={{ marginTop: "1.5rem", fontSize: "0.9rem" }}>
          New here? <a href="https://thetidytool.com/#quote">Request a free quote →</a>
        </p>
      </main>
    </>
  );
}

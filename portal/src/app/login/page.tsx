"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Surface a failed/expired sign-in link (the /auth/confirm route redirects here).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "link") {
      setError("That sign-in link was invalid or expired. Request a new one below.");
    }
  }, []);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const addr = email.trim();
    if (!addr) {
      setError("Please enter your email.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    // Invite/claim-only: do NOT create new users from the login form. Customers are
    // provisioned ahead of time (Supabase dashboard invite now; automated invite flow later).
    const { error } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { emailRedirectTo: `${siteUrl}/auth/confirm`, shouldCreateUser: false },
    });
    setBusy(false);
    if (error) {
      // Supabase returns an error when the email has no account (signups disabled).
      const notProvisioned = /signups? not allowed|not allowed for otp|user not found/i.test(
        error.message,
      );
      setError(
        notProvisioned
          ? "We couldn't find an account for that email. If you've ordered from us, contact sam@thetidytool.com to get access."
          : error.message,
      );
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
          Enter the email on your TidyTool order. We&apos;ll send you a secure
          sign-in link — no password to remember.
        </p>

        {sent ? (
          <div className="card" style={{ marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "1.1rem" }}>Check your email</h2>
            <p className="muted" style={{ margin: 0 }}>
              We sent a sign-in link to <strong>{email}</strong>. Open it on this
              device to continue.
            </p>
          </div>
        ) : (
          <form className="card" style={{ marginTop: "1.25rem" }} onSubmit={sendLink}>
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
            <button className="btn btn--primary btn--block" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
            <p className="err" role="alert">
              {error}
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

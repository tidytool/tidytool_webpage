import { SignOutButton } from "./SignOutButton";

export function Header({ email, isAdmin }: { email?: string | null; isAdmin?: boolean }) {
  return (
    <header className="site-header">
      <div className="container">
        <a className="brand" href="/">
          tidy<span>tool</span>
        </a>
        {email ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
            {isAdmin ? (
              <a href="/admin" style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                Admin
              </a>
            ) : null}
            <span className="muted" style={{ fontSize: "0.85rem" }}>
              {email}
            </span>
            <SignOutButton />
          </div>
        ) : (
          <a className="btn btn--ghost" href="https://thetidytool.com/">
            ← thetidytool.com
          </a>
        )}
      </div>
    </header>
  );
}

import { SignOutButton } from "./SignOutButton";

export function Header({ email }: { email?: string | null }) {
  return (
    <header className="site-header">
      <div className="container">
        <a className="brand" href="/">
          tidy<span>tool</span>
        </a>
        {email ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
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

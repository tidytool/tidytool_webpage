import { Header } from "@/components/Header";

export default function NotFound() {
  return (
    <>
      <Header />
      <main className="wrap" style={{ textAlign: "center", paddingTop: "3rem" }}>
        <h1>Not found</h1>
        <p className="muted">
          We couldn&apos;t find that design. The link may be old or incomplete.
        </p>
        <p style={{ marginTop: "1.5rem" }}>
          <a className="btn btn--primary" href="/">
            Back to your designs
          </a>
        </p>
      </main>
    </>
  );
}

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="app-content" style={{ maxWidth: 640, textAlign: "center", paddingTop: "4rem" }}>
      <h1>Page not found</h1>
      <p className="muted">That route is not part of the Fortune & Automations Business Dashboard.</p>
      <Link className="btn secondary" href="/dashboard">
        Back to dashboard
      </Link>
    </div>
  );
}

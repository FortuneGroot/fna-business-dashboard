import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand-lockup" style={{ justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo" src="/fna-logo.jpg" alt="" width={42} height={42} />
        </div>
        <h1 className="serif" style={{ textAlign: "center" }}>
          Fortune & Automations
        </h1>
        <p className="muted" style={{ textAlign: "center" }}>
          Business Dashboard
        </p>
        <p className="muted" style={{ textAlign: "center" }}>
          Make Your Business Look Better. Work Smarter. Run Smoother.
        </p>
        <div className="banner">
          Sign-in is a placeholder. Intended address: app.fortuneandautomations.com. Accounts and
          live customer data are <strong>not connected</strong> yet. Google login stays off until
          the branded redirect is inspected.
        </div>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com" disabled />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" placeholder="Not connected" disabled />
        <p className="muted">Authentication backend pending. Use preview to inspect the branded shell.</p>
        <div style={{ display: "flex", gap: "0.6rem", marginTop: "1.1rem", flexWrap: "wrap" }}>
          <Link className="btn" href="/dashboard">
            Continue as preview
          </Link>
          <Link className="btn secondary" href="/help">
            Help
          </Link>
        </div>
      </div>
    </div>
  );
}

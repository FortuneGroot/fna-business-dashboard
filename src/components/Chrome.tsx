import Link from "next/link";

export function Footer() {
  return (
    <footer className="app-footer">
      <div className="footer-inner">
        <div>
          Fortune & Automations · Fortune&Finance LLC
          <div className="muted">Intended host: app.fortuneandautomations.com</div>
        </div>
        <div>
          <Link href="/privacy">Privacy</Link>
          {" · "}
          <Link href="/terms">Terms</Link>
          {" · "}
          <Link href="/support">Contact</Link>
        </div>
      </div>
    </footer>
  );
}

export function StatusBanner({ children }: { children: React.ReactNode }) {
  return <div className="banner">{children}</div>;
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Footer } from "@/components/Chrome";

const NAV = [
  { href: "/platform", label: "Workspaces" },
  { href: "/platform/audit", label: "Audit log" },
];

/**
 * Platform administration frame: the existing top bar, content, and footer styles without the client
 * sidebar, so platform pages are never mistaken for a workspace's own pages.
 */
export function PlatformShell({ email, children }: { email: string; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="app-main">
        <header className="app-topbar">
          <div className="topbar-leading">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-logo" src="/fna-logo.jpg" alt="" width={32} height={32} />
            <h1 className="topbar-title">Platform administration</h1>
            <nav aria-label="Platform" style={{ display: "flex", gap: "0.4rem", marginLeft: "0.75rem" }}>
              {NAV.map((item) => {
                const active = item.href === "/platform" ? path === "/platform" || path.startsWith("/platform/workspaces") : path.startsWith(item.href);
                return (
                  <Link key={item.href} href={item.href} className={`btn ${active ? "" : "ghost"} sm`} aria-current={active ? "page" : undefined}>
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="topbar-actions">
            <span className="muted" style={{ fontSize: "0.85rem" }}>{email}</span>
            <button className="btn secondary topbar-signout" type="button" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main-content" className="app-content" tabIndex={-1}>
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}

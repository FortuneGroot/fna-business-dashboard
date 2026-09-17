"use client";

import { useRouter } from "next/navigation";
import { MobileMenuButton } from "./Sidebar";

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/inbox": "Conversations",
  "/contacts": "Contacts",
  "/pipeline": "Opportunities",
  "/calendar": "Calendars",
  "/automations": "Automations",
  "/marketing": "Marketing",
  "/reviews": "Reputation",
  "/payments": "Payments",
  "/reporting": "Reports",
  "/settings": "Settings",
  "/help": "Help & Support",
  "/support": "Help & Support",
  "/library": "Resources",
  "/training": "Training",
  "/onboarding": "Onboarding",
  "/tasks": "Tasks",
};

export function TopBar({ path, onMenu }: { path: string; onMenu: () => void }) {
  const router = useRouter();
  const title = TITLES[path] ?? "Business Dashboard";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="app-topbar">
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <MobileMenuButton onClick={onMenu} />
        <span className="topbar-title">{title}</span>
      </div>
      <div className="topbar-actions">
        <div className="topbar-search" aria-hidden="true">
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          Search
        </div>
        <button className="topbar-icon-btn" type="button" aria-label="Notifications">
          <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          <span className="dot" />
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={logout}
          style={{ padding: "0.35rem 0.7rem", fontSize: "0.8rem" }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

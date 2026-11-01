"use client";

import { useRouter } from "next/navigation";
import { MobileMenuButton } from "./Sidebar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

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
  "/support": "Support",
  "/library": "Resources",
  "/training": "Training",
  "/onboarding": "Onboarding",
  "/tasks": "Tasks",
};

export function TopBar({
  path,
  onMenu,
  menuOpen = false,
}: {
  path: string;
  onMenu: () => void;
  menuOpen?: boolean;
}) {
  const router = useRouter();
  const title = TITLES[path] ?? "Business Dashboard";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="app-topbar">
      <div className="topbar-leading">
        <MobileMenuButton onClick={onMenu} open={menuOpen} />
        <h1 className="topbar-title">{title}</h1>
      </div>
      <div className="topbar-actions">
        <label className="topbar-search" htmlFor="topbar-search-input">
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span className="sr-only">Search</span>
          <input
            id="topbar-search-input"
            type="search"
            placeholder="Search (coming soon)"
            disabled
            aria-disabled="true"
          />
        </label>
        <WorkspaceSwitcher />
        <button className="btn secondary topbar-signout" type="button" onClick={logout}>
          Sign out
        </button>
      </div>
    </header>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { BRAND } from "@/lib/brand";
import type { AuthRole } from "@/lib/auth/types";
import { canAccessLibrary } from "@/lib/auth/types";

type TenantChrome = {
  client?: { businessName?: string };
  platform?: { brandName?: string; productName?: string; legal?: string };
};

function Icon({ d }: { d: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ICONS: Record<string, string> = {
  dashboard: "M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z",
  conversations: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.6-.8L4 20l1-4.7A8.5 8.5 0 1 1 21 11.5Z",
  contacts: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 10v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75",
  opportunities: "M4 19h16M4 19V9l5-4 5 4 4-2v12",
  calendar: "M8 2v4M16 2v4M3.5 9h17M4 5h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  automations: "M13 2 3 14h7l-1 8 11-14h-7l0-6Z",
  marketing: "M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Zm14-4a5 5 0 0 1 0 10M15 9a2.5 2.5 0 0 1 0 5",
  reputation: "m12 2 3.1 6.6L22 9.6l-5 4.9 1.2 6.9L12 18l-6.2 3.4L7 14.5 2 9.6l6.9-1L12 2Z",
  payments: "M2 8h20M2 6h20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm4 9h4",
  reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 0-.15-1.5l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.6-1.5L14.5 2h-5l-.35 2.5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a8 8 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.6 1.5L9.5 22h5l.35-2.5a8 8 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.6c.1-.5.15-1 .15-1.5Z",
  help: "M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 1.8v.5M12 17.5h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  resources: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5V6A2.5 2.5 0 0 1 6.5 3.5H20v14H6.5A2.5 2.5 0 0 0 4 19.5Z",
  tasks: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
};

const PRIMARY = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/inbox", label: "Conversations", icon: "conversations" },
  { href: "/contacts", label: "Contacts", icon: "contacts" },
  { href: "/pipeline", label: "Opportunities", icon: "opportunities" },
  { href: "/calendar", label: "Calendars", icon: "calendar" },
  { href: "/tasks", label: "Tasks", icon: "tasks" },
  { href: "/automations", label: "Automations", icon: "automations" },
  { href: "/marketing", label: "Marketing", icon: "marketing" },
  { href: "/reviews", label: "Reputation", icon: "reputation" },
  { href: "/payments", label: "Payments", icon: "payments" },
  { href: "/reporting", label: "Reports", icon: "reports" },
];

type NavItem = { href: string; label: string; icon: string; minRole?: AuthRole };

const SECONDARY: NavItem[] = [
  { href: "/settings", label: "Settings", icon: "settings" },
  { href: "/help", label: "Help & Support", icon: "help" },
  { href: "/library", label: "Resources", icon: "resources", minRole: "ADMIN" },
];

function isActivePath(path: string, href: string): boolean {
  if (path === href) return true;
  if (href === "/dashboard") return false;
  return path.startsWith(`${href}/`);
}

function navVisibleForRole(item: NavItem, role: AuthRole | null): boolean {
  if (!item.minRole) return true;
  if (!role) return false;
  if (item.minRole === "ADMIN") return canAccessLibrary(role);
  return false;
}

export function SidebarLinks({
  onNavigate,
  role,
}: {
  onNavigate?: () => void;
  role?: AuthRole | null;
}) {
  const path = usePathname();
  const renderLink = (l: NavItem) => (
    <Link
      key={l.href}
      href={l.href}
      className="sidebar-link"
      aria-current={isActivePath(path, l.href) ? "page" : undefined}
      onClick={onNavigate}
    >
      <Icon d={ICONS[l.icon]} />
      {l.label}
    </Link>
  );
  const secondary = SECONDARY.filter((l) => navVisibleForRole(l, role ?? null));
  return (
    <nav className="sidebar-nav" aria-label="Primary">
      {PRIMARY.map(renderLink)}
      <div className="sidebar-section-label" id="sidebar-account-label">
        Account
      </div>
      <div role="group" aria-labelledby="sidebar-account-label">
        {secondary.map(renderLink)}
      </div>
    </nav>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tenant, setTenant] = useState<TenantChrome | null>(null);
  const [role, setRole] = useState<AuthRole | null>(null);
  useEffect(() => {
    fetch("/api/tenant/public")
      .then((r) => r.json())
      .then(setTenant)
      .catch(() => undefined);
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const next = d?.user?.role;
        if (next === "OWNER" || next === "ADMIN" || next === "CLIENT") setRole(next);
      })
      .catch(() => undefined);
  }, []);

  const clientName = tenant?.client?.businessName || BRAND.name;
  const legal = tenant?.platform?.legal || BRAND.legal;
  const productLine = "Business Dashboard";

  return (
    <>
      {open ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close menu"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={`app-sidebar${open ? " open" : ""}`}
        aria-label="Application"
        id="app-sidebar"
      >
        <div className="sidebar-brand-row">
          <Link className="sidebar-brand" href="/dashboard" onClick={onClose}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/fna-logo.jpg" alt="Fortune & Automations" width={36} height={36} />
            <span className="sidebar-brand-text">
              <strong>{clientName}</strong>
              <small>{productLine}</small>
            </span>
          </Link>
          <button className="sidebar-close" onClick={onClose} aria-label="Close menu" type="button">
            ×
          </button>
        </div>
        <SidebarLinks onNavigate={onClose} role={role} />
        <div className="sidebar-footer">{legal} · AUTOMATION · WEBSITES · BRANDING · SYSTEMS</div>
      </aside>
    </>
  );
}

export function MobileMenuButton({
  onClick,
  open = false,
}: {
  onClick: () => void;
  open?: boolean;
}) {
  return (
    <button
      className="menu-btn"
      type="button"
      onClick={onClick}
      aria-label={open ? "Close menu" : "Open menu"}
      aria-controls="app-sidebar"
      aria-expanded={open}
    >
      <Icon d="M3 6h18M3 12h18M3 18h18" />
    </button>
  );
}

export function useSidebar() {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

export function SidebarIcon({ name }: { name: keyof typeof ICONS }) {
  return <Icon d={ICONS[name]} />;
}

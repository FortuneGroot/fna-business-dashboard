"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sidebar, useSidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Footer } from "./Chrome";
import { SupportAccessBanner } from "./SupportAccess";
import { WorkspaceChangedBanner } from "./WorkspaceSwitcher";

function AccessDeniedBanner() {
  const path = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const denied = search.get("denied") === "1";

  useEffect(() => {
    if (!denied) return;
    const next = new URLSearchParams(search.toString());
    next.delete("denied");
    const qs = next.toString();
    router.replace(qs ? `${path}?${qs}` : path);
  }, [denied, path, router, search]);

  if (!denied) return null;
  return (
    <div className="banner error" role="alert" style={{ marginBottom: "1rem" }}>
      You do not have access to that page. Contact your account owner if you need it enabled.
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { open, setOpen } = useSidebar();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="app-main">
        <TopBar path={path} onMenu={() => setOpen(true)} menuOpen={open} />
        <main id="main-content" className="app-content" tabIndex={-1}>
          <WorkspaceChangedBanner />
          <SupportAccessBanner />
          <Suspense fallback={null}>
            <AccessDeniedBanner />
          </Suspense>
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}

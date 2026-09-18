"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, useSidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Footer } from "./Chrome";

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
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}

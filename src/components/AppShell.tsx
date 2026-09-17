"use client";

import { usePathname } from "next/navigation";
import { Sidebar, useSidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Footer } from "./Chrome";

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { open, setOpen } = useSidebar();
  return (
    <div className="app-layout">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="app-main">
        <TopBar path={path} onMenu={() => setOpen(true)} />
        <main className="app-content">{children}</main>
        <Footer />
      </div>
    </div>
  );
}

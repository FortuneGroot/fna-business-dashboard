import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Join workspace",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InviteLayout({ children }: { children: ReactNode }) {
  return children;
}

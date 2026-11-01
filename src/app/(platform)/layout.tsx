import { notFound } from "next/navigation";
import { authProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

/** The platform console exists only with AUTH_PROVIDER=supabase; each page checks platform authority. */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  if (authProvider() !== "supabase") notFound();
  return children;
}

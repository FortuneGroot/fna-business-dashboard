import { requirePageSession } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageSession();
  return children;
}

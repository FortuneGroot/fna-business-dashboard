import { redirect } from "next/navigation";
import { MfaSetup } from "@/components/platform/MfaSetup";
import { requireListedPlatformAdmin } from "@/lib/platform/page";
import { verifiedFactors } from "@/lib/auth/mfa";

export const dynamic = "force-dynamic";

export const metadata = { title: "Verify · Platform administration" };

export default async function PlatformMfaPage() {
  const { status } = await requireListedPlatformAdmin();
  if (status.active) redirect("/platform");
  const { getPageSupabase } = await import("@/lib/authz/context");
  const factors = await verifiedFactors(await getPageSupabase());
  return <MfaSetup factorId={factors[0]?.id ?? null} />;
}

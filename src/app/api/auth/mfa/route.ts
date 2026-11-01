import type { NextRequest } from "next/server";
import { mfaApi, verifiedFactors } from "@/lib/auth/mfa";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return mfaApi(req, async (supabase, status) => ({
    aal: status.aal,
    platformActive: status.active,
    factors: await verifiedFactors(supabase),
  }));
}

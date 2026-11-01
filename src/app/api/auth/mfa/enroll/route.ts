import type { NextRequest } from "next/server";
import { enrollTotp, mfaApi } from "@/lib/auth/mfa";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return mfaApi(req, async (supabase) => enrollTotp(supabase));
}

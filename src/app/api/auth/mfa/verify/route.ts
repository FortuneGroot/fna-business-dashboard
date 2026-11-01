import type { NextRequest } from "next/server";
import { parseBody } from "@/lib/api/native";
import { mfaApi, verifyBody, verifyTotp } from "@/lib/auth/mfa";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return mfaApi(req, async (supabase) => verifyTotp(supabase, await parseBody(req, verifyBody)));
}

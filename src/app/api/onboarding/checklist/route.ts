import type { NextRequest } from "next/server";
import { nativeApi } from "@/lib/api/native";
import { onboardingChecklist } from "@/lib/native/onboarding";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "onboarding.read" }, async (scope) => ({
    items: await onboardingChecklist(scope),
  }));
}

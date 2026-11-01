import type { NextRequest } from "next/server";
import { nativeApi, parseBody } from "@/lib/api/native";
import { aiPatch, getAiConfig, updateAiConfig } from "@/lib/native/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "ai_receptionist.read" }, async (scope) => ({
    config: await getAiConfig(scope),
  }));
}

/** Configuration only: the receptionist stays disabled and no provider is contacted. */
export async function PUT(req: NextRequest) {
  return nativeApi(req, { permission: "ai_receptionist.write" }, async (scope) => {
    const patch = await parseBody(req, aiPatch);
    return { config: await updateAiConfig(scope, patch) };
  });
}

import type { NextRequest } from "next/server";
import { nativeApi, parseBody } from "@/lib/api/native";
import { getWorkspaceSettings, settingsPatch, updateWorkspaceSettings } from "@/lib/native/settings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "settings.read" }, async (scope) => ({
    settings: await getWorkspaceSettings(scope),
  }));
}

export async function PATCH(req: NextRequest) {
  return nativeApi(req, { permission: "settings.write" }, async (scope) => {
    const patch = await parseBody(req, settingsPatch);
    return { settings: await updateWorkspaceSettings(scope, patch) };
  });
}

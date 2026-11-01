import type { NextRequest } from "next/server";
import { nativeApi } from "@/lib/api/native";
import { listIntegrations } from "@/lib/native/integrations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "integrations.read" }, async (scope) => ({
    items: await listIntegrations(scope),
  }));
}

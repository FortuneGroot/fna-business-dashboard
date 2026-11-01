import type { NextRequest } from "next/server";
import { nativeApi } from "@/lib/api/native";
import { listTeam } from "@/lib/native/team";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "team.read" }, async (scope) => {
    const members = await listTeam(scope);
    return { members };
  });
}

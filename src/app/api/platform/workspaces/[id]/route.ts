import type { NextRequest } from "next/server";
import { parseId } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { getWorkspace, listGrants } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return platformApi(req, {}, async (scope) => {
    const workspaceId = parseId(id);
    const workspace = await getWorkspace(scope, workspaceId);
    return { workspace, grants: await listGrants(scope, { workspaceId, include: "all", limit: 20 }) };
  });
}

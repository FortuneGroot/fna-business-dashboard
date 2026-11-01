import type { NextRequest } from "next/server";
import { parseBody, parseId } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { reasonBody, suspendWorkspace } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return platformApi(req, { sensitive: true }, async (scope) => {
    const workspaceId = parseId(id);
    const { reason } = await parseBody(req, reasonBody);
    return { workspace: await suspendWorkspace(scope, workspaceId, reason) };
  });
}

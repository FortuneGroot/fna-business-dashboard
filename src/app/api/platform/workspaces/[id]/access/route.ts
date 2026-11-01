import type { NextRequest } from "next/server";
import { parseBody, parseId } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { accessBody, grantAccess } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return platformApi(req, { sensitive: true }, async (scope) => {
    const workspaceId = parseId(id);
    return { grant: await grantAccess(scope, workspaceId, await parseBody(req, accessBody)) };
  });
}

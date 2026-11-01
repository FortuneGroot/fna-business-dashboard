import type { NextRequest } from "next/server";
import { parseBody, parseId } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { reasonBody, revokeGrant } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ grantId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const { grantId } = await params;
  return platformApi(req, { sensitive: true }, async (scope) => {
    const id = parseId(grantId, "grantId");
    const { reason } = await parseBody(req, reasonBody);
    await revokeGrant(scope, id, reason);
    return {};
  });
}

import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { moveInput, moveOpportunity } from "@/lib/native/opportunities";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "opportunities.write" }, async (scope) => {
    const opportunityId = parseId(id);
    const { stageId } = await parseBody(req, moveInput);
    return { opportunity: await moveOpportunity(scope, opportunityId, stageId) };
  });
}

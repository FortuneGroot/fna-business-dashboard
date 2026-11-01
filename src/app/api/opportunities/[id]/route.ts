import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { deleteOpportunity, getOpportunity, opportunityPatch, updateOpportunity } from "@/lib/native/opportunities";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "pipeline.read" }, async (scope) => ({ opportunity: await getOpportunity(scope, parseId(id)) }));
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "opportunities.write" }, async (scope) => {
    const opportunityId = parseId(id);
    const input = await parseBody(req, opportunityPatch);
    return { opportunity: await updateOpportunity(scope, opportunityId, input) };
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "opportunities.delete" }, async (scope) => {
    await deleteOpportunity(scope, parseId(id));
    return {};
  });
}

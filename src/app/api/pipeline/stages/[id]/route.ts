import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { renameStage, stagePatch } from "@/lib/native/opportunities";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "pipeline.configure" }, async (scope) => {
    const stageId = parseId(id);
    const { name } = await parseBody(req, stagePatch);
    return { stage: await renameStage(scope, stageId, name) };
  });
}

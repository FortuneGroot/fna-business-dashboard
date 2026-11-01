import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { taskPatch, updateTask } from "@/lib/native/tasks";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "tasks.write" }, async (scope) => {
    const taskId = parseId(id);
    const input = await parseBody(req, taskPatch);
    return { task: await updateTask(scope, taskId, input) };
  });
}

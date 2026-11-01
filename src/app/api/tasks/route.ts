import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseQuery } from "@/lib/api/native";
import { createTask, listTasks, taskCreate, taskListQuery } from "@/lib/native/tasks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "tasks.read" }, async (scope) => listTasks(scope, parseQuery(req, taskListQuery)));
}

export async function POST(req: NextRequest) {
  return nativeApi(req, { permission: "tasks.write" }, async (scope) => {
    const input = await parseBody(req, taskCreate);
    return { task: await createTask(scope, input) };
  });
}

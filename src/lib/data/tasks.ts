import "server-only";
import type { TaskEventRecord } from "@/lib/data/records";
import { taskEventRecord, type NativeTaskRow } from "./dashboard-adapters";
import { displayNames, fromWorkspace, rows, type DataScope } from "./query";

export async function listTaskEvents(scope: DataScope, limit = 100): Promise<TaskEventRecord[]> {
  const data = await rows<NativeTaskRow>(
    fromWorkspace(scope, "tasks", "id, title, status, contact_id, opportunity_id, assigned_user_id, updated_at")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(limit),
    "tasks"
  );
  const names = await displayNames(scope, data.map((t) => t.assigned_user_id));
  return data.map((t) => taskEventRecord(t, names));
}

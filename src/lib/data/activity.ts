import "server-only";
import type { AuditEventRecord } from "@/lib/data/records";
import { auditEventRecord, type NativeActivityRow } from "./dashboard-adapters";
import { activeWorkspaceId, fromWorkspace, rows, type DataScope } from "./query";

/** Workspace activity (activity_events) in the audit-event shape used by the dashboard. */
export async function listActivity(scope: DataScope, limit = 100): Promise<AuditEventRecord[]> {
  const data = await rows<NativeActivityRow>(
    fromWorkspace(scope, "activity_events", "id, entity_type, entity_id, action, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    "activity_events"
  );
  const workspace = activeWorkspaceId(scope);
  return data.map((e) => auditEventRecord(e, workspace));
}

import "server-only";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "@/lib/api/native";
import { displayNames, type DataScope } from "@/lib/data/query";
import { fromWorkspaceRows } from "./shared";

export type AuditItem = {
  id: number;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorKind: "member" | "platform_admin" | "system";
  target: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type RawAudit = {
  id: number;
  action: string;
  actor_id: string | null;
  actor_kind: AuditItem["actorKind"];
  target: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const auditCursor = z.strictObject({ id: z.number().int().positive() });

/** Newest-first workspace audit log (audit.read), keyset-paginated on id. */
export async function listAudit(
  scope: DataScope,
  page: { limit: number; cursor?: string }
): Promise<{ items: AuditItem[]; nextCursor: string | null }> {
  const after = decodeCursor(page.cursor, auditCursor);
  const rows = await fromWorkspaceRows<RawAudit>(
    scope,
    "workspace_audit_log",
    "id, action, actor_id, actor_kind, target, metadata, created_at",
    (q) => {
      const filtered = after ? q.lt("id", after.id) : q;
      return filtered.order("id", { ascending: false }).limit(page.limit + 1);
    }
  );
  const pageRows = rows.slice(0, page.limit);
  const names = await displayNames(scope, pageRows.map((r) => r.actor_id));
  return {
    items: pageRows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      actorId: r.actor_id,
      actorName: r.actor_id ? names.get(r.actor_id) ?? null : null,
      actorKind: r.actor_kind,
      target: r.target,
      metadata: r.metadata ?? {},
      createdAt: r.created_at,
    })),
    nextCursor: rows.length > page.limit ? encodeCursor({ id: Number(pageRows[pageRows.length - 1].id) }) : null,
  };
}

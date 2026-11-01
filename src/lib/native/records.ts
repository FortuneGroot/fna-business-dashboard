import "server-only";
import { z } from "zod";
import { check, decodeCursor, encodeCursor, invalid, uuid } from "@/lib/api/native";
import { activeWorkspaceId, type DataScope } from "@/lib/data/query";

/** PostgREST timestamps (`2026-11-01T14:47:25.709123+00:00`); nothing else may reach a filter. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Keyset position on (timestamp column, id), newest first. */
export const keysetCursor = z.strictObject({ t: z.string().regex(TIMESTAMP), id: uuid });
export type Keyset = z.infer<typeof keysetCursor>;

export function decodeKeyset(cursor: string | undefined): Keyset | null {
  return decodeCursor(cursor, keysetCursor);
}

/** `or` filter for rows strictly after `after` in (column desc, id desc) order. Inputs are validated. */
export function afterKeyset(column: string, after: Keyset): string {
  return `${column}.lt.${after.t},and(${column}.eq.${after.t},id.lt.${after.id.toLowerCase()})`;
}

export function nextKeyset<T extends { id: string }>(rows: T[], limit: number, time: (row: T) => string): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  return encodeCursor({ t: time(last), id: last.id });
}

/**
 * Search words for an ilike `or` filter. Only letters, digits, and a few punctuation marks survive,
 * so a search can never add PostgREST filter syntax (commas, parentheses, quotes, wildcards).
 */
export function searchWords(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}@.+_' -]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .slice(0, 5);
}

export const isoDateTime = z.iso.datetime({ offset: true, message: "Use an ISO 8601 date-time with a time zone" });

/** Optional relation id: a UUID, or null to clear. */
export const ref = uuid.nullable();

/** At least one field must be present in a PATCH body. */
export function nonEmpty<T extends Record<string, unknown>>(value: T): boolean {
  return Object.values(value).some((v) => v !== undefined);
}

/** True when `id` names a live (not soft-deleted when the table has `deleted_at`) row of the active workspace. */
export async function exists(scope: DataScope, table: string, id: string, softDeleted = true): Promise<boolean> {
  let q = scope.supabase.from(table).select("id").eq("workspace_id", activeWorkspaceId(scope)).eq("id", id);
  if (softDeleted) q = q.is("deleted_at", null);
  const data = check(await q.maybeSingle());
  return Boolean(data);
}

/** Rejects a reference that is not a live record of the active workspace (422, never a 404 or a leak). */
export async function requireRef(scope: DataScope, table: string, id: string | null | undefined, field: string, label: string, softDeleted = true) {
  if (!id) return;
  if (!(await exists(scope, table, id, softDeleted))) throw invalid({ [field]: `Choose ${label} in this workspace` });
}

/** Names of contacts by id (live rows only), for list displays. */
export async function contactNames(scope: DataScope, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const data = check(
    await scope.supabase
      .from("contacts")
      .select("id, first_name, last_name, email, phone")
      .eq("workspace_id", activeWorkspaceId(scope))
      .in("id", unique)
  ) as { id: string; first_name: string; last_name: string; email: string | null; phone: string | null }[] | null;
  return new Map((data ?? []).map((c) => [c.id, contactLabel(c)]));
}

export function contactLabel(c: { first_name: string; last_name: string; email: string | null; phone: string | null }): string {
  return `${c.first_name} ${c.last_name}`.trim() || c.email || c.phone || "Unnamed contact";
}

/** Maps a 23503 from a write that names an assignee/owner to a field error. */
export function memberField(field: string) {
  return invalid({ [field]: "Choose an active member of this workspace" });
}

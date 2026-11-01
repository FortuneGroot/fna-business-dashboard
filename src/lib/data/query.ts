import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RequestContext } from "@/lib/authz/evaluate";

/** A native read failed (database unreachable or refused); routes answer 503 `unavailable`. */
export class DataUnavailableError extends Error {}

/**
 * The per-request Supabase client (user JWT) and the request context it was verified with. The data
 * layer takes the workspace from `ctx` only (spec §6.3); RLS re-checks it on every query.
 */
export type DataScope = { readonly supabase: SupabaseClient; readonly ctx: RequestContext };

/** Newest-first cap for list reads; totals come from exact counts instead. */
export const LIST_LIMIT = 500;

type Result<T> = PromiseLike<{ data: T | null; error: unknown; count?: number | null }>;

export function activeWorkspaceId(scope: DataScope): string {
  const id = scope.ctx.workspace?.id;
  if (!id) throw new DataUnavailableError("no active workspace");
  return id;
}

/** `select` on a workspace table, filtered to the context's workspace. */
export function fromWorkspace(scope: DataScope, table: string, columns: string) {
  return scope.supabase.from(table).select(columns).eq("workspace_id", activeWorkspaceId(scope));
}

/** Exact row count of a workspace table (HEAD request; no rows transferred). */
export function countWorkspace(scope: DataScope, table: string) {
  return scope.supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", activeWorkspaceId(scope));
}

export async function rows<T>(query: Result<unknown>, table: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new DataUnavailableError(`${table} unavailable`);
  return (Array.isArray(data) ? data : []) as T[];
}

export async function total(query: Result<unknown>, table: string): Promise<number> {
  const { error, count } = await query;
  if (error || typeof count !== "number") throw new DataUnavailableError(`${table} count unavailable`);
  return count;
}

/**
 * Splits ids for `in` filters. The ids travel in the request URL, and the API gateway refuses URLs
 * of several hundred UUIDs, so lookups for long lists go out in batches.
 */
export function idChunks(ids: string[], size = 100): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Display names for user ids, from the profiles the caller may see. */
export async function displayNames(scope: DataScope, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const pages = await Promise.all(
    idChunks(unique).map((chunk) =>
      rows<{ user_id: string; full_name: string }>(scope.supabase.from("profiles").select("user_id, full_name").in("user_id", chunk), "profiles")
    )
  );
  return new Map(pages.flat().filter((p) => p.full_name).map((p) => [p.user_id, p.full_name]));
}

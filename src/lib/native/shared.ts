import "server-only";
import { check } from "@/lib/api/native";
import { fromWorkspace, type DataScope } from "@/lib/data/query";

export { check };

type Query = ReturnType<typeof fromWorkspace>;
type Awaitable = PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;

/** Rows of a workspace table read with the caller's JWT; failures map to §7.1 errors. */
export async function fromWorkspaceRows<T>(
  scope: DataScope,
  table: string,
  columns: string,
  build: (q: Query) => Awaitable = (q) => q
): Promise<T[]> {
  const data = check(await build(fromWorkspace(scope, table, columns)));
  return (Array.isArray(data) ? data : []) as T[];
}

/** One row of a workspace table, or null. */
export async function fromWorkspaceRow<T>(
  scope: DataScope,
  table: string,
  columns: string,
  build: (q: Query) => Query = (q) => q
): Promise<T | null> {
  const data = check(await build(fromWorkspace(scope, table, columns)).maybeSingle());
  return (data ?? null) as T | null;
}

/** Exact count of matching rows (HEAD request). */
export async function countRows(
  scope: DataScope,
  table: string,
  build: (q: Query) => Query = (q) => q
): Promise<number> {
  const q = build(scope.supabase.from(table).select("*", { count: "exact", head: true }).eq("workspace_id", scope.ctx.workspace!.id) as unknown as Query);
  const res = await q;
  check(res);
  return res.count ?? 0;
}

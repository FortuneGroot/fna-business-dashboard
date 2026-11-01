import "server-only";
import { z } from "zod";
import { check, invalid, notFound, pageQuery, uuid } from "@/lib/api/native";
import { activeWorkspaceId, countWorkspace, displayNames, total, type DataScope } from "@/lib/data/query";
import { afterKeyset, contactNames, decodeKeyset, isoDateTime, nextKeyset, nonEmpty, requireRef } from "./records";

export type TaskStatus = "open" | "done" | "cancelled";
export type TaskItem = {
  id: string;
  title: string;
  description: string;
  dueAt: string | null;
  status: TaskStatus;
  contactId: string | null;
  contactName: string | null;
  opportunityId: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawTask = {
  id: string;
  title: string;
  description: string;
  due_at: string | null;
  status: TaskStatus;
  contact_id: string | null;
  opportunity_id: string | null;
  assigned_user_id: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS = "id, title, description, due_at, status, contact_id, opportunity_id, assigned_user_id, created_at, updated_at";
const STATUSES = ["open", "done", "cancelled"] as const;

const fields = {
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().max(10000),
  dueAt: isoDateTime.nullable(),
  contactId: uuid.nullable(),
  opportunityId: uuid.nullable(),
  assignedUserId: uuid.nullable(),
  status: z.enum(STATUSES),
};

export const taskCreate = z.strictObject({
  title: fields.title,
  description: fields.description.optional(),
  dueAt: fields.dueAt.optional(),
  contactId: fields.contactId.optional(),
  opportunityId: fields.opportunityId.optional(),
  assignedUserId: fields.assignedUserId.optional(),
  status: fields.status.optional(),
});

export const taskPatch = z
  .strictObject({
    title: fields.title.optional(),
    description: fields.description.optional(),
    dueAt: fields.dueAt.optional(),
    contactId: fields.contactId.optional(),
    opportunityId: fields.opportunityId.optional(),
    assignedUserId: fields.assignedUserId.optional(),
    status: fields.status.optional(),
  })
  .refine(nonEmpty, { message: "Provide at least one field", path: ["body"] });

export const taskListQuery = z.strictObject({
  status: z.enum(STATUSES).optional(),
  assignedUserId: uuid.optional(),
  ...pageQuery,
});

async function toItems(scope: DataScope, rows: RawTask[]): Promise<TaskItem[]> {
  const [names, contacts] = await Promise.all([
    displayNames(scope, rows.map((r) => r.assigned_user_id)),
    contactNames(scope, rows.map((r) => r.contact_id)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    dueAt: r.due_at,
    status: r.status,
    contactId: r.contact_id,
    contactName: r.contact_id ? contacts.get(r.contact_id) ?? null : null,
    opportunityId: r.opportunity_id,
    assignedUserId: r.assigned_user_id,
    assignedName: r.assigned_user_id ? names.get(r.assigned_user_id) ?? null : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

type ListQuery = z.infer<typeof taskListQuery>;

function filtered(scope: DataScope, query: ListQuery, select: string, options?: { count: "exact"; head: true }) {
  let q = scope.supabase.from("tasks").select(select, options).eq("workspace_id", activeWorkspaceId(scope)).is("deleted_at", null);
  if (query.status) q = q.eq("status", query.status);
  if (query.assignedUserId) q = q.eq("assigned_user_id", query.assignedUserId.toLowerCase());
  return q;
}

/** GET /api/tasks: newest first, keyset-paginated, exact total for the filters. */
export async function listTasks(scope: DataScope, query: ListQuery) {
  const after = decodeKeyset(query.cursor);
  let page = filtered(scope, query, COLUMNS);
  if (after) page = page.or(afterKeyset("created_at", after));
  const [rows, count] = await Promise.all([
    page.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1),
    filtered(scope, query, "id", { count: "exact", head: true }),
  ]);
  const data = (check(rows) as unknown as RawTask[] | null) ?? [];
  check(count);
  return {
    items: await toItems(scope, data.slice(0, query.limit)),
    nextCursor: nextKeyset(data, query.limit, (r) => r.created_at),
    total: count.count ?? 0,
  };
}

/** Exact counts for the Tasks page: all live tasks, open, done, and open ones not updated for 7 days. */
export async function taskCounts(scope: DataScope): Promise<{ total: number; open: number; done: number; stale: number }> {
  const live = () => countWorkspace(scope, "tasks").is("deleted_at", null);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [all, open, done, stale] = await Promise.all([
    total(live(), "tasks"),
    total(live().eq("status", "open"), "tasks"),
    total(live().eq("status", "done"), "tasks"),
    total(live().eq("status", "open").lt("updated_at", weekAgo), "tasks"),
  ]);
  return { total: all, open, done, stale };
}

function lower(id: string | null | undefined): string | null | undefined {
  return typeof id === "string" ? id.toLowerCase() : id;
}

function writeFailure(res: { error: { code?: string } | null }) {
  if (res.error?.code === "23503") throw invalid({ body: "A referenced record does not exist in this workspace, or the assignee is not an active member" });
}

/** Linked contact and opportunity must be live records of this workspace. */
async function checkRefs(scope: DataScope, input: { contactId?: string | null; opportunityId?: string | null }) {
  await requireRef(scope, "contacts", lower(input.contactId), "contactId", "a contact");
  await requireRef(scope, "opportunities", lower(input.opportunityId), "opportunityId", "an opportunity");
}

function columns(input: z.infer<typeof taskPatch>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.description !== undefined) out.description = input.description;
  if (input.dueAt !== undefined) out.due_at = input.dueAt ? new Date(input.dueAt).toISOString() : null;
  if (input.contactId !== undefined) out.contact_id = lower(input.contactId);
  if (input.opportunityId !== undefined) out.opportunity_id = lower(input.opportunityId);
  if (input.assignedUserId !== undefined) out.assigned_user_id = lower(input.assignedUserId);
  if (input.status !== undefined) out.status = input.status;
  return out;
}

export async function createTask(scope: DataScope, input: z.infer<typeof taskCreate>): Promise<TaskItem> {
  await checkRefs(scope, input);
  const res = await scope.supabase
    .from("tasks")
    .insert({ workspace_id: activeWorkspaceId(scope), ...columns(input) })
    .select(COLUMNS)
    .single();
  writeFailure(res);
  return (await toItems(scope, [check(res) as unknown as RawTask]))[0];
}

export async function updateTask(scope: DataScope, id: string, input: z.infer<typeof taskPatch>): Promise<TaskItem> {
  await checkRefs(scope, input);
  const res = await scope.supabase.from("tasks").update(columns(input)).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id)
    .is("deleted_at", null).select(COLUMNS).maybeSingle();
  writeFailure(res);
  const row = check(res) as unknown as RawTask | null;
  if (!row) throw notFound();
  return (await toItems(scope, [row]))[0];
}

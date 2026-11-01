import "server-only";
import { z } from "zod";
import { check, invalid, notFound, pageQuery, uuid } from "@/lib/api/native";
import { activeWorkspaceId, displayNames, type DataScope } from "@/lib/data/query";
import { afterKeyset, contactNames, decodeKeyset, memberField, nextKeyset, nonEmpty, requireRef } from "./records";

export type Stage = { id: string; name: string; position: number; kind: "open" | "won" | "lost" | "nurture" };
export type Pipeline = { id: string; name: string; stages: Stage[] };

export type OpportunityItem = {
  id: string;
  title: string;
  valueCents: number;
  currency: string;
  status: "open" | "won" | "lost";
  pipelineId: string;
  stageId: string;
  stageName: string | null;
  contactId: string;
  contactName: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

type RawOpportunity = {
  id: string;
  title: string;
  value_cents: number | string;
  currency: string;
  status: OpportunityItem["status"];
  pipeline_id: string;
  stage_id: string;
  contact_id: string;
  assigned_user_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

const COLUMNS = "id, title, value_cents, currency, status, pipeline_id, stage_id, contact_id, assigned_user_id, created_at, updated_at, closed_at";

const title = z.string().trim().min(1, "Title is required").max(200);
/** Whole cents, up to $10 billion. */
const valueCents = z.number().int("Use whole cents").min(0, "Value cannot be negative").max(1_000_000_000_000);

export const opportunityCreate = z.strictObject({
  contactId: uuid,
  stageId: uuid,
  title,
  valueCents: valueCents.optional(),
  assignedUserId: uuid.nullable().optional(),
});

export const opportunityPatch = z
  .strictObject({ title: title.optional(), valueCents: valueCents.optional(), assignedUserId: uuid.nullable().optional() })
  .refine(nonEmpty, { message: "Provide at least one field", path: ["body"] });

export const moveInput = z.strictObject({ stageId: uuid });

export const stagePatch = z.strictObject({ name: z.string().trim().min(1, "Stage name is required").max(60) });

export const opportunityListQuery = z.strictObject({
  stageId: uuid.optional(),
  assignedUserId: uuid.optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  ...pageQuery,
});

/** GET /api/pipeline: the workspace's default pipeline with its stages in order. */
export async function getPipeline(scope: DataScope): Promise<Pipeline | null> {
  const ws = activeWorkspaceId(scope);
  const pipeline = check(
    await scope.supabase.from("pipelines").select("id, name").eq("workspace_id", ws).order("is_default", { ascending: false }).limit(1).maybeSingle()
  ) as { id: string; name: string } | null;
  if (!pipeline) return null;
  const stages = (check(
    await scope.supabase.from("pipeline_stages").select("id, name, position, kind").eq("workspace_id", ws).eq("pipeline_id", pipeline.id).order("position")
  ) as Stage[] | null) ?? [];
  return { id: pipeline.id, name: pipeline.name, stages };
}

/** PATCH /api/pipeline/stages/[id]: rename only (positions and kinds are frozen by the database). */
export async function renameStage(scope: DataScope, id: string, name: string): Promise<Stage> {
  const data = check(
    await scope.supabase.from("pipeline_stages").update({ name }).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id)
      .select("id, name, position, kind").maybeSingle()
  ) as Stage | null;
  if (!data) throw notFound();
  return data;
}

async function toItems(scope: DataScope, rows: RawOpportunity[]): Promise<OpportunityItem[]> {
  const ws = activeWorkspaceId(scope);
  const stageIds = [...new Set(rows.map((r) => r.stage_id))];
  const [names, contacts, stages] = await Promise.all([
    displayNames(scope, rows.map((r) => r.assigned_user_id)),
    contactNames(scope, rows.map((r) => r.contact_id)),
    stageIds.length
      ? scope.supabase.from("pipeline_stages").select("id, name").eq("workspace_id", ws).in("id", stageIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const stageNames = new Map(((check(stages) as { id: string; name: string }[] | null) ?? []).map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    valueCents: Number(r.value_cents),
    currency: r.currency.trim(),
    status: r.status,
    pipelineId: r.pipeline_id,
    stageId: r.stage_id,
    stageName: stageNames.get(r.stage_id) ?? null,
    contactId: r.contact_id,
    contactName: contacts.get(r.contact_id) ?? null,
    assignedUserId: r.assigned_user_id,
    assignedName: r.assigned_user_id ? names.get(r.assigned_user_id) ?? null : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  }));
}

type ListQuery = z.infer<typeof opportunityListQuery>;

function filtered(scope: DataScope, query: ListQuery, select: string, options?: { count: "exact"; head: true }) {
  let q = scope.supabase.from("opportunities").select(select, options).eq("workspace_id", activeWorkspaceId(scope)).is("deleted_at", null);
  if (query.stageId) q = q.eq("stage_id", query.stageId.toLowerCase());
  if (query.assignedUserId) q = q.eq("assigned_user_id", query.assignedUserId.toLowerCase());
  if (query.status) q = q.eq("status", query.status);
  return q;
}

/** GET /api/opportunities: newest first, keyset-paginated, exact total for the filters. */
export async function listOpportunities(scope: DataScope, query: ListQuery) {
  const after = decodeKeyset(query.cursor);
  let page = filtered(scope, query, COLUMNS);
  if (after) page = page.or(afterKeyset("created_at", after));
  const [rows, count] = await Promise.all([
    page.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1),
    filtered(scope, query, "id", { count: "exact", head: true }),
  ]);
  const data = (check(rows) as unknown as RawOpportunity[] | null) ?? [];
  check(count);
  return {
    items: await toItems(scope, data.slice(0, query.limit)),
    nextCursor: nextKeyset(data, query.limit, (r) => r.created_at),
    total: count.count ?? 0,
  };
}

async function opportunityRow(scope: DataScope, id: string): Promise<RawOpportunity> {
  const data = check(
    await scope.supabase.from("opportunities").select(COLUMNS).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id).is("deleted_at", null).maybeSingle()
  ) as RawOpportunity | null;
  if (!data) throw notFound();
  return data;
}

export async function getOpportunity(scope: DataScope, id: string): Promise<OpportunityItem> {
  return (await toItems(scope, [await opportunityRow(scope, id)]))[0];
}

function writeFailure(res: { error: { code?: string } | null }, field = "assignedUserId") {
  if (res.error?.code === "23503") throw memberField(field);
}

/** POST /api/opportunities: the stage decides the pipeline (and, by trigger, the status). */
export async function createOpportunity(scope: DataScope, input: z.infer<typeof opportunityCreate>): Promise<OpportunityItem> {
  const ws = activeWorkspaceId(scope);
  const stage = check(
    await scope.supabase.from("pipeline_stages").select("id, pipeline_id").eq("workspace_id", ws).eq("id", input.stageId.toLowerCase()).maybeSingle()
  ) as { id: string; pipeline_id: string } | null;
  if (!stage) throw invalid({ stageId: "Choose a stage of this workspace's pipeline" });
  await requireRef(scope, "contacts", input.contactId.toLowerCase(), "contactId", "a contact");
  const res = await scope.supabase
    .from("opportunities")
    .insert({
      workspace_id: ws,
      contact_id: input.contactId.toLowerCase(),
      pipeline_id: stage.pipeline_id,
      stage_id: stage.id,
      title: input.title,
      value_cents: input.valueCents ?? 0,
      assigned_user_id: input.assignedUserId ? input.assignedUserId.toLowerCase() : null,
    })
    .select(COLUMNS)
    .single();
  writeFailure(res);
  return (await toItems(scope, [check(res) as unknown as RawOpportunity]))[0];
}

export async function updateOpportunity(scope: DataScope, id: string, input: z.infer<typeof opportunityPatch>): Promise<OpportunityItem> {
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.valueCents !== undefined) patch.value_cents = input.valueCents;
  if (input.assignedUserId !== undefined) patch.assigned_user_id = input.assignedUserId ? input.assignedUserId.toLowerCase() : null;
  const res = await scope.supabase.from("opportunities").update(patch).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id)
    .is("deleted_at", null).select(COLUMNS).maybeSingle();
  writeFailure(res);
  const row = check(res) as unknown as RawOpportunity | null;
  if (!row) throw notFound();
  return (await toItems(scope, [row]))[0];
}

/** POST /api/opportunities/[id]/move: by stage id, within the opportunity's own pipeline. */
export async function moveOpportunity(scope: DataScope, id: string, stageId: string): Promise<OpportunityItem> {
  const ws = activeWorkspaceId(scope);
  const current = await opportunityRow(scope, id);
  const stage = check(
    await scope.supabase.from("pipeline_stages").select("id").eq("workspace_id", ws).eq("pipeline_id", current.pipeline_id)
      .eq("id", stageId.toLowerCase()).maybeSingle()
  ) as { id: string } | null;
  if (!stage) throw invalid({ stageId: "Choose a stage of this opportunity's pipeline" });
  const row = check(
    await scope.supabase.from("opportunities").update({ stage_id: stage.id }).eq("workspace_id", ws).eq("id", id)
      .is("deleted_at", null).select(COLUMNS).maybeSingle()
  ) as unknown as RawOpportunity | null;
  if (!row) throw notFound();
  return (await toItems(scope, [row]))[0];
}

export async function deleteOpportunity(scope: DataScope, id: string): Promise<void> {
  check(await scope.supabase.rpc("soft_delete_opportunity", { p_id: id }));
}

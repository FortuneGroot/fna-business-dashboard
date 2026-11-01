import "server-only";
import type { OpportunityRecord } from "@/lib/data/records";
import { opportunityRecord, type NativeOpportunityRow, type NativeStageRow } from "./dashboard-adapters";
import { displayNames, fromWorkspace, LIST_LIMIT, rows, type DataScope } from "./query";
import type { StageTotals } from "./types";

export type PipelineConfig = { name: string; stages: NativeStageRow[] } | null;

/** The default pipeline (or the first by name) and its stages in board order. */
export async function loadPipeline(scope: DataScope): Promise<PipelineConfig> {
  const [pipeline] = await rows<{ id: string; name: string }>(
    fromWorkspace(scope, "pipelines", "id, name")
      .order("is_default", { ascending: false })
      .order("name", { ascending: true })
      .limit(1),
    "pipelines"
  );
  if (!pipeline) return null;
  const stages = await rows<NativeStageRow>(
    fromWorkspace(scope, "pipeline_stages", "id, pipeline_id, name, position, kind")
      .eq("pipeline_id", pipeline.id)
      .order("position", { ascending: true }),
    "pipeline_stages"
  );
  return { name: pipeline.name, stages };
}

export async function listOpportunities(scope: DataScope): Promise<OpportunityRecord[]> {
  const [data, stages] = await Promise.all([
    rows<NativeOpportunityRow>(
      fromWorkspace(
        scope,
        "opportunities",
        "id, contact_id, pipeline_id, stage_id, status, value_cents, assigned_user_id, created_at, updated_at"
      )
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(LIST_LIMIT),
      "opportunities"
    ),
    rows<NativeStageRow>(fromWorkspace(scope, "pipeline_stages", "id, pipeline_id, name, position, kind"), "pipeline_stages"),
  ]);
  const names = await displayNames(scope, data.map((o) => o.assigned_user_id));
  const byId = new Map(stages.map((s) => [s.id, s]));
  return data.map((o) => opportunityRecord(o, byId, names));
}

/**
 * Count and value (cents) of non-deleted opportunities per stage id of the given stages. Pages through
 * every row like `openValueCents`, so the totals are exact beyond list caps and the server's row cap.
 */
export async function stageTotals(scope: DataScope, stageIds: readonly string[]): Promise<StageTotals> {
  const totals = new Map<string, { count: number; valueCents: number }>(stageIds.map((id) => [id, { count: 0, valueCents: 0 }]));
  if (!stageIds.length) return totals;
  for (let from = 0; ; ) {
    const page = await rows<{ id: string; stage_id: string; value_cents: number | string }>(
      fromWorkspace(scope, "opportunities", "id, stage_id, value_cents")
        .in("stage_id", [...stageIds])
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, from + 999),
      "opportunities"
    );
    if (!page.length) return totals;
    for (const o of page) {
      const t = totals.get(o.stage_id);
      if (t) {
        t.count += 1;
        t.valueCents += Number(o.value_cents) || 0;
      }
    }
    from += page.length;
  }
}

/**
 * Sum of open opportunity values in cents. Pages through every open row (the API caps each response),
 * stopping at the first empty page, so the total does not depend on the server's row cap.
 */
export async function openValueCents(scope: DataScope): Promise<number> {
  let sum = 0;
  for (let from = 0; ; ) {
    const page = await rows<{ id: string; value_cents: number | string }>(
      fromWorkspace(scope, "opportunities", "id, value_cents")
        .eq("status", "open")
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(from, from + 999),
      "opportunities"
    );
    if (!page.length) return sum;
    for (const o of page) sum += Number(o.value_cents) || 0;
    from += page.length;
  }
}

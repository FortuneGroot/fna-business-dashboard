import "server-only";
import { z } from "zod";
import { check } from "@/lib/api/native";
import { activeWorkspaceId, type DataScope } from "@/lib/data/query";
import { isoDateTime } from "./records";

const DAY_MS = 86_400_000;

export const reportQuery = z
  .strictObject({ from: isoDateTime.optional(), to: isoDateTime.optional() })
  .refine((q) => !q.from || endOf(q) > Date.parse(q.from), { message: "`to` must be after `from`", path: ["to"] })
  .refine((q) => !q.from || endOf(q) - Date.parse(q.from) <= 400 * DAY_MS, { message: "Use a range of at most 400 days", path: ["to"] });

/** The range end the summary will use: `to`, or now when it is omitted. */
function endOf(q: { to?: string }): number {
  return q.to ? Date.parse(q.to) : Date.now();
}

/** The [from, to) a validated query covers: `to` defaults to now, `from` to 30 days before `to`. */
export function reportRange(query: z.infer<typeof reportQuery>, now = Date.now()): { from: string; to: string } {
  const to = query.to ? new Date(query.to) : new Date(now);
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

const APPOINTMENT_STATUSES = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;

/**
 * GET /api/reports/summary for [from, to) (default: the last 30 days). Counts are exact HEAD counts;
 * values are summed in integer cents from paged rows, so totals stay exact beyond `max_rows`.
 */
export async function reportSummary(scope: DataScope, query: z.infer<typeof reportQuery>) {
  const ws = activeWorkspaceId(scope);
  const range = reportRange(query);

  const head = (table: string) => scope.supabase.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", ws);
  const counted = async (q: PromiseLike<{ data: unknown; count: number | null; error: { message?: string; code?: string } | null }>) => {
    const res = await q;
    check(res);
    return res.count ?? 0;
  };

  const stages = (check(
    await scope.supabase.from("pipeline_stages").select("id, name, position, kind").eq("workspace_id", ws).order("position")
  ) as { id: string; name: string; position: number; kind: string }[] | null) ?? [];

  const openByStage = new Map<string, { count: number; valueCents: number }>();
  let wonValueCents = 0;
  let wonCount = 0;
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const rows = (check(
      await scope.supabase.from("opportunities").select("id, stage_id, status, value_cents, closed_at").eq("workspace_id", ws).is("deleted_at", null)
        .order("id").range(offset, offset + PAGE - 1)
    ) as { id: string; stage_id: string; status: string; value_cents: number | string; closed_at: string | null }[] | null) ?? [];
    for (const r of rows) {
      const cents = Number(r.value_cents);
      const entry = openByStage.get(r.stage_id) ?? { count: 0, valueCents: 0 };
      entry.count += 1;
      entry.valueCents += cents;
      openByStage.set(r.stage_id, entry);
      const closed = r.closed_at ? Date.parse(r.closed_at) : NaN;
      if (r.status === "won" && closed >= Date.parse(range.from) && closed < Date.parse(range.to)) {
        wonCount += 1;
        wonValueCents += cents;
      }
    }
    if (rows.length === 0) break;
  }

  const [newContacts, ...appointmentCounts] = await Promise.all([
    counted(head("contacts").is("deleted_at", null).gte("created_at", range.from).lt("created_at", range.to)),
    ...APPOINTMENT_STATUSES.map((s) =>
      counted(head("appointments").is("deleted_at", null).eq("status", s).gte("starts_at", range.from).lt("starts_at", range.to))
    ),
  ]);

  return {
    range,
    leadsByStage: stages.map((s) => ({
      stageId: s.id,
      name: s.name,
      kind: s.kind,
      count: openByStage.get(s.id)?.count ?? 0,
      valueCents: openByStage.get(s.id)?.valueCents ?? 0,
    })),
    wonCount,
    wonValueCents,
    newContacts,
    appointmentsByStatus: Object.fromEntries(APPOINTMENT_STATUSES.map((s, i) => [s, appointmentCounts[i]])),
  };
}

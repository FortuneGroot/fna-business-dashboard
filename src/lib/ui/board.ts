import type { AppointmentRecord, OpportunityRecord } from "@/lib/data/records";
import type { StageTotals, WorkspaceCalendar, WorkspaceStage } from "@/lib/data/types";

export type PipelineColumn = { key: string; title: string; items: OpportunityRecord[]; count: number; value: number };

/**
 * Board columns. Native: one column per stage, an opportunity belongs to exactly one column by stage
 * id, and counts and values are the exact database totals. Legacy: one column per configured stage
 * name, matched by name over the synced list (unchanged pre-P3 behaviour).
 */
export function pipelineColumns(input: {
  native: boolean;
  stages: readonly WorkspaceStage[];
  stageNames: readonly string[];
  opportunities: readonly OpportunityRecord[];
  totals: StageTotals;
}): PipelineColumn[] {
  const { opportunities: opps } = input;
  if (input.native) {
    return input.stages.map((stage) => {
      const t = input.totals.get(stage.id) ?? { count: 0, valueCents: 0 };
      return {
        key: stage.id,
        title: stage.name,
        items: opps.filter((o) => o.stageId === stage.id),
        count: t.count,
        value: t.valueCents / 100,
      };
    });
  }
  return input.stageNames.map((stage) => {
    const items = opps.filter((o) => {
      const name = (o.stageName || o.status || "").toLowerCase();
      return name === stage.toLowerCase() || name.includes(stage.toLowerCase());
    });
    return {
      key: stage,
      title: stage,
      items,
      count: items.length,
      value: items.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0),
    };
  });
}

/**
 * Bookings listed on a calendar card. Native: exactly the bookings with this calendar's id (an empty
 * calendar stays empty). Legacy: the pre-P3 name matching, falling back to every booking.
 */
export function calendarAppointments(
  native: boolean,
  calendar: WorkspaceCalendar,
  appointments: readonly AppointmentRecord[]
): AppointmentRecord[] {
  if (native) return appointments.filter((a) => a.calendarId === calendar.id);
  const items = appointments.filter(
    (a) =>
      !a.calendarName ||
      a.calendarName.toLowerCase() === calendar.name.toLowerCase() ||
      a.calendarId === calendar.id ||
      a.calendarName.toLowerCase().includes(calendar.name.toLowerCase().split(" ")[0])
  );
  return items.length ? items : [...appointments];
}

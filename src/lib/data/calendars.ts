import "server-only";
import type { AppointmentRecord } from "@/lib/data/records";
import { appointmentRecord, type NativeAppointmentRow, type NativeCalendarRow } from "./dashboard-adapters";
import { displayNames, fromWorkspace, LIST_LIMIT, rows, type DataScope } from "./query";

const CALENDAR_COLUMNS = "id, name, timezone, duration_minutes, is_primary";

/** Active calendars, primary first. */
export function listCalendars(scope: DataScope): Promise<NativeCalendarRow[]> {
  return rows<NativeCalendarRow>(
    fromWorkspace(scope, "calendars", CALENDAR_COLUMNS)
      .eq("active", true)
      .order("is_primary", { ascending: false })
      .order("name", { ascending: true }),
    "calendars"
  );
}

export function formatDuration(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} hr` : `${minutes} min`;
}

export async function listAppointments(scope: DataScope): Promise<AppointmentRecord[]> {
  const [data, calendars] = await Promise.all([
    rows<NativeAppointmentRow>(
      fromWorkspace(
        scope,
        "appointments",
        "id, calendar_id, contact_id, assigned_user_id, starts_at, ends_at, status, created_at, updated_at"
      )
        .is("deleted_at", null)
        .order("starts_at", { ascending: false })
        .limit(LIST_LIMIT),
      "appointments"
    ),
    rows<NativeCalendarRow>(fromWorkspace(scope, "calendars", CALENDAR_COLUMNS), "calendars"),
  ]);
  const names = await displayNames(scope, data.map((a) => a.assigned_user_id));
  const byId = new Map(calendars.map((c) => [c.id, c]));
  return data.map((a) => appointmentRecord(a, byId, names));
}

import "server-only";
import { z } from "zod";
import { ApiError, check, conflict, invalid, notFound, uuid } from "@/lib/api/native";
import { activeWorkspaceId, displayNames, type DataScope } from "@/lib/data/query";
import { contactNames, isoDateTime, memberField, nonEmpty, requireRef } from "./records";

export type AvailabilityRule = { weekday: number; start: string; end: string };
export type CalendarItem = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  durationMinutes: number;
  isPrimary: boolean;
  active: boolean;
  members: { userId: string; name: string | null }[];
  rules: AvailabilityRule[];
};

export type AppointmentStatus = "booked" | "confirmed" | "completed" | "cancelled" | "no_show";
export type AppointmentItem = {
  id: string;
  calendarId: string;
  contactId: string;
  contactName: string | null;
  opportunityId: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type RawCalendar = { id: string; name: string; slug: string; timezone: string; duration_minutes: number; is_primary: boolean; active: boolean };
type RawAppointment = {
  id: string;
  calendar_id: string;
  contact_id: string;
  opportunity_id: string | null;
  assigned_user_id: string | null;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  notes: string;
  created_at: string;
  updated_at: string;
};

const CALENDAR_COLUMNS = "id, name, slug, timezone, duration_minutes, is_primary, active";
const APPOINTMENT_COLUMNS = "id, calendar_id, contact_id, opportunity_id, assigned_user_id, starts_at, ends_at, status, notes, created_at, updated_at";

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const calendarFields = {
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,60}$/, "Use 1–60 lowercase letters, digits, or hyphens"),
  timezone: z.string().trim().min(1).max(64).refine(isTimeZone, "Unknown timezone"),
  durationMinutes: z.number().int().min(5, "At least 5 minutes").max(480, "At most 8 hours"),
  active: z.boolean(),
  memberUserIds: z.array(uuid).max(100).transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
};

export const calendarCreate = z.strictObject({
  name: calendarFields.name,
  slug: calendarFields.slug,
  timezone: calendarFields.timezone,
  durationMinutes: calendarFields.durationMinutes,
  active: calendarFields.active.optional(),
  memberUserIds: calendarFields.memberUserIds.optional(),
});

export const calendarPatch = z
  .strictObject({
    name: calendarFields.name.optional(),
    slug: calendarFields.slug.optional(),
    timezone: calendarFields.timezone.optional(),
    durationMinutes: calendarFields.durationMinutes.optional(),
    active: calendarFields.active.optional(),
    memberUserIds: calendarFields.memberUserIds.optional(),
  })
  .refine(nonEmpty, { message: "Provide at least one field", path: ["body"] });

export const availabilityInput = z
  .strictObject({
    rules: z
      .array(
        z
          .strictObject({ weekday: z.number().int().min(0).max(6), start: hhmm, end: hhmm })
          .refine((r) => r.start < r.end, { message: "End must be after start", path: ["end"] })
      )
      .max(50, "Use at most 50 rules"),
  })
  .superRefine((value, ctx) => {
    const sorted = [...value.rules].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].weekday === sorted[i - 1].weekday && sorted[i].start < sorted[i - 1].end) {
        ctx.addIssue({ code: "custom", message: "Availability windows on the same day cannot overlap", path: ["rules"] });
        return;
      }
    }
  });

const STATUSES = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;
const DAY_MS = 86_400_000;

export const appointmentCreate = z
  .strictObject({
    calendarId: uuid,
    contactId: uuid,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    opportunityId: uuid.nullable().optional(),
    assignedUserId: uuid.nullable().optional(),
    notes: z.string().max(10000).optional(),
  })
  .refine((a) => Date.parse(a.endsAt) > Date.parse(a.startsAt), { message: "End must be after start", path: ["endsAt"] })
  .refine((a) => Date.parse(a.endsAt) - Date.parse(a.startsAt) <= DAY_MS, { message: "An appointment can last at most 24 hours", path: ["endsAt"] });

export const appointmentPatch = z
  .strictObject({
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
    status: z.enum(STATUSES).optional(),
    notes: z.string().max(10000).optional(),
    assignedUserId: uuid.nullable().optional(),
  })
  .refine(nonEmpty, { message: "Provide at least one field", path: ["body"] })
  .refine((a) => !a.startsAt || !a.endsAt || Date.parse(a.endsAt) > Date.parse(a.startsAt), { message: "End must be after start", path: ["endsAt"] });

export const appointmentListQuery = z
  .strictObject({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    calendarId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) > Date.parse(q.from), { message: "`to` must be after `from`", path: ["to"] })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 400 * DAY_MS, { message: "Use a range of at most 400 days", path: ["to"] });

async function calendarItems(scope: DataScope, rows: RawCalendar[]): Promise<CalendarItem[]> {
  const ws = activeWorkspaceId(scope);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const [members, rules] = await Promise.all([
    scope.supabase.from("calendar_members").select("calendar_id, user_id").eq("workspace_id", ws).in("calendar_id", ids),
    scope.supabase.from("availability_rules").select("calendar_id, weekday, start_time, end_time").eq("workspace_id", ws).in("calendar_id", ids)
      .order("weekday").order("start_time"),
  ]);
  const memberRows = (check(members) as { calendar_id: string; user_id: string }[] | null) ?? [];
  const ruleRows = (check(rules) as { calendar_id: string; weekday: number; start_time: string; end_time: string }[] | null) ?? [];
  const names = await displayNames(scope, memberRows.map((m) => m.user_id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    timezone: r.timezone,
    durationMinutes: r.duration_minutes,
    isPrimary: r.is_primary,
    active: r.active,
    members: memberRows.filter((m) => m.calendar_id === r.id).map((m) => ({ userId: m.user_id, name: names.get(m.user_id) ?? null })),
    rules: ruleRows
      .filter((x) => x.calendar_id === r.id)
      .map((x) => ({ weekday: x.weekday, start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5) })),
  }));
}

/** GET /api/calendars: every calendar of the workspace with members and weekly availability. */
export async function listCalendars(scope: DataScope): Promise<CalendarItem[]> {
  const rows = (check(
    await scope.supabase.from("calendars").select(CALENDAR_COLUMNS).eq("workspace_id", activeWorkspaceId(scope))
      .order("is_primary", { ascending: false }).order("name").order("id").limit(200)
  ) as RawCalendar[] | null) ?? [];
  return calendarItems(scope, rows);
}

async function getCalendar(scope: DataScope, id: string): Promise<CalendarItem> {
  const row = check(
    await scope.supabase.from("calendars").select(CALENDAR_COLUMNS).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id).maybeSingle()
  ) as RawCalendar | null;
  if (!row) throw notFound();
  return (await calendarItems(scope, [row]))[0];
}

function calendarFailure(error: { code?: string } | null): ApiError | null {
  if (!error) return null;
  if (error.code === "23505") return conflict("Another calendar in this workspace already uses this slug", "duplicate_slug");
  if (error.code === "23503") return memberField("memberUserIds");
  return null;
}

/** POST / PATCH: one transaction through rpc save_calendar (fields and member set together). */
export async function saveCalendar(scope: DataScope, id: string | null, input: z.infer<typeof calendarPatch>): Promise<CalendarItem> {
  const values: Record<string, unknown> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.slug !== undefined) values.slug = input.slug;
  if (input.timezone !== undefined) values.timezone = input.timezone;
  if (input.durationMinutes !== undefined) values.duration_minutes = input.durationMinutes;
  if (input.active !== undefined) values.active = input.active;
  const res = await scope.supabase.rpc("save_calendar", { p_id: id, p_values: values, p_member_ids: input.memberUserIds ?? null });
  const mapped = calendarFailure(res.error);
  if (mapped) throw mapped;
  return getCalendar(scope, check(res) as string);
}

export async function replaceAvailability(scope: DataScope, id: string, rules: AvailabilityRule[]): Promise<AvailabilityRule[]> {
  check(await scope.supabase.rpc("replace_availability", { p_calendar_id: id, p_rules: rules }));
  return (await getCalendar(scope, id)).rules;
}

async function appointmentItems(scope: DataScope, rows: RawAppointment[]): Promise<AppointmentItem[]> {
  const [names, contacts] = await Promise.all([
    displayNames(scope, rows.map((r) => r.assigned_user_id)),
    contactNames(scope, rows.map((r) => r.contact_id)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    calendarId: r.calendar_id,
    contactId: r.contact_id,
    contactName: contacts.get(r.contact_id) ?? null,
    opportunityId: r.opportunity_id,
    assignedUserId: r.assigned_user_id,
    assignedName: r.assigned_user_id ? names.get(r.assigned_user_id) ?? null : null,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** GET /api/appointments: bookings overlapping [from, to), soonest first, capped at `limit`. */
export async function listAppointments(scope: DataScope, query: z.infer<typeof appointmentListQuery>) {
  let q = scope.supabase.from("appointments").select(APPOINTMENT_COLUMNS).eq("workspace_id", activeWorkspaceId(scope)).is("deleted_at", null);
  if (query.from) q = q.gt("ends_at", new Date(query.from).toISOString());
  if (query.to) q = q.lt("starts_at", new Date(query.to).toISOString());
  if (query.calendarId) q = q.eq("calendar_id", query.calendarId.toLowerCase());
  const rows = (check(await q.order("starts_at").order("id").limit(query.limit + 1)) as RawAppointment[] | null) ?? [];
  return { items: await appointmentItems(scope, rows.slice(0, query.limit)), truncated: rows.length > query.limit };
}

function appointmentFailure(res: { error: { code?: string } | null }) {
  if (res.error?.code === "23503") throw invalid({ body: "A referenced record does not exist in this workspace, or the assignee is not an active member" });
  if (res.error?.code === "23514") throw invalid({ endsAt: "End must be after start" });
}

/** POST /api/appointments: 409 `overlap` when the calendar already has a live booking in that slot. */
export async function createAppointment(scope: DataScope, input: z.infer<typeof appointmentCreate>): Promise<AppointmentItem> {
  const ws = activeWorkspaceId(scope);
  const calendar = check(
    await scope.supabase.from("calendars").select("id, active").eq("workspace_id", ws).eq("id", input.calendarId.toLowerCase()).maybeSingle()
  ) as { id: string; active: boolean } | null;
  if (!calendar || !calendar.active) throw invalid({ calendarId: "Choose an active calendar in this workspace" });
  await requireRef(scope, "contacts", input.contactId.toLowerCase(), "contactId", "a contact");
  await requireRef(scope, "opportunities", input.opportunityId?.toLowerCase(), "opportunityId", "an opportunity");
  const res = await scope.supabase
    .from("appointments")
    .insert({
      workspace_id: ws,
      calendar_id: calendar.id,
      contact_id: input.contactId.toLowerCase(),
      opportunity_id: input.opportunityId ? input.opportunityId.toLowerCase() : null,
      assigned_user_id: input.assignedUserId ? input.assignedUserId.toLowerCase() : null,
      starts_at: new Date(input.startsAt).toISOString(),
      ends_at: new Date(input.endsAt).toISOString(),
      notes: input.notes ?? "",
    })
    .select(APPOINTMENT_COLUMNS)
    .single();
  appointmentFailure(res);
  return (await appointmentItems(scope, [check(res) as unknown as RawAppointment]))[0];
}

export async function updateAppointment(scope: DataScope, id: string, input: z.infer<typeof appointmentPatch>): Promise<AppointmentItem> {
  const patch: Record<string, unknown> = {};
  if (input.startsAt !== undefined) patch.starts_at = new Date(input.startsAt).toISOString();
  if (input.endsAt !== undefined) patch.ends_at = new Date(input.endsAt).toISOString();
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.assignedUserId !== undefined) patch.assigned_user_id = input.assignedUserId ? input.assignedUserId.toLowerCase() : null;
  const res = await scope.supabase.from("appointments").update(patch).eq("workspace_id", activeWorkspaceId(scope)).eq("id", id)
    .is("deleted_at", null).select(APPOINTMENT_COLUMNS).maybeSingle();
  appointmentFailure(res);
  const row = check(res) as unknown as RawAppointment | null;
  if (!row) throw notFound();
  return (await appointmentItems(scope, [row]))[0];
}

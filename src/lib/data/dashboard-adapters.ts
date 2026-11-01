import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  OpportunityRecord,
  ReviewEventRecord,
  SyncEventType,
  TaskEventRecord,
} from "@/lib/sync/types";

/**
 * Maps native workspace rows (spec §5.3 tables) to the pre-migration record shapes in
 * src/lib/sync/types.ts, so pages and /api/dashboard/* keep their output unchanged (API-1).
 * Pure functions: no I/O, no workspace argument.
 */

export type NativeContactRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  source: string;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
  contact_tags?: { tag: string }[] | null;
};

export type NativeOpportunityRow = {
  id: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  status: "open" | "won" | "lost";
  value_cents: number | string;
  assigned_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type NativeStageRow = { id: string; pipeline_id: string; name: string; position: number; kind: string };

export type NativeCalendarRow = {
  id: string;
  name: string;
  timezone: string;
  duration_minutes: number;
  is_primary: boolean;
};

export type NativeAppointmentRow = {
  id: string;
  calendar_id: string;
  contact_id: string;
  assigned_user_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type NativeConversationRow = { id: string; contact_id: string; channel: string };

export type NativeMessageRow = {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound" | "internal";
  created_at: string;
};

export type NativeTaskRow = {
  id: string;
  title: string;
  status: string;
  contact_id: string | null;
  opportunity_id: string | null;
  assigned_user_id: string | null;
  updated_at: string;
};

export type NativeReviewRow = { id: string; contact_id: string | null; rating: number | null; received_at: string };

export type NativeActivityRow = {
  id: number | string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  created_at: string;
};

/** User id -> display name, from profiles visible to the caller. */
export type NameLookup = ReadonlyMap<string, string>;

const nameOf = (names: NameLookup, id: string | null): string | undefined =>
  id ? names.get(id) || undefined : undefined;

export const centsToAmount = (cents: number | string): number => Number(cents) / 100;

export function contactRecord(row: NativeContactRow, names: NameLookup): ContactRecord {
  const displayName = [row.first_name, row.last_name].filter(Boolean).join(" ");
  return {
    externalContactId: row.id,
    firstName: row.first_name || undefined,
    lastName: row.last_name || undefined,
    displayName: displayName || undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    source: row.source || undefined,
    tags: (row.contact_tags ?? []).map((t) => String(t.tag)),
    assignedUser: nameOf(names, row.owner_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function opportunityRecord(
  row: NativeOpportunityRow,
  stages: ReadonlyMap<string, NativeStageRow>,
  names: NameLookup
): OpportunityRecord {
  return {
    externalOpportunityId: row.id,
    contactId: row.contact_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    stageName: stages.get(row.stage_id)?.name,
    status: row.status,
    monetaryValue: centsToAmount(row.value_cents),
    assignedUser: nameOf(names, row.assigned_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function appointmentRecord(
  row: NativeAppointmentRow,
  calendars: ReadonlyMap<string, NativeCalendarRow>,
  names: NameLookup
): AppointmentRecord {
  const calendar = calendars.get(row.calendar_id);
  return {
    externalAppointmentId: row.id,
    contactId: row.contact_id,
    calendarId: row.calendar_id,
    calendarName: calendar?.name,
    status: row.status,
    start: row.starts_at,
    end: row.ends_at,
    timezone: calendar?.timezone,
    assignedUser: nameOf(names, row.assigned_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MESSAGE_SUMMARY: Record<NativeMessageRow["direction"], string> = {
  inbound: "Inbound message",
  outbound: "Outbound message",
  internal: "Internal note",
};

/** One conversation event per message. Message bodies are not included (summary only, as before). */
export function conversationEventRecord(
  message: NativeMessageRow,
  conversations: ReadonlyMap<string, NativeConversationRow>
): ConversationEventRecord {
  const conversation = conversations.get(message.conversation_id);
  return {
    id: message.id,
    contactId: conversation?.contact_id,
    direction: message.direction === "internal" ? "unknown" : message.direction,
    channel: conversation?.channel,
    eventType: message.direction === "internal" ? "conversation.internal" : `conversation.${message.direction}`,
    timestamp: message.created_at,
    summary: MESSAGE_SUMMARY[message.direction],
  };
}

export function taskEventRecord(row: NativeTaskRow, names: NameLookup): TaskEventRecord {
  return {
    id: row.id,
    contactId: row.contact_id ?? undefined,
    opportunityId: row.opportunity_id ?? undefined,
    type: row.title,
    status: row.status,
    assignedUser: nameOf(names, row.assigned_user_id),
    timestamp: row.updated_at,
  };
}

export function reviewEventRecord(row: NativeReviewRow): ReviewEventRecord {
  return {
    id: row.id,
    contactId: row.contact_id ?? undefined,
    kind: "feedback-received",
    resultStatus: row.rating ? `${row.rating}/5` : undefined,
    timestamp: row.received_at,
  };
}

const ACTIVITY_EVENT_TYPES: Record<string, SyncEventType> = {
  "contact.created": "lead.created",
  "contact.updated": "lead.updated",
  "opportunity.created": "opportunity.created",
  "opportunity.updated": "opportunity.updated",
  "opportunity.stage_changed": "opportunity.stage_changed",
  "opportunity.won": "opportunity.won",
  "opportunity.lost": "opportunity.lost",
  "appointment.booked": "appointment.booked",
  "appointment.created": "appointment.booked",
  "appointment.rescheduled": "appointment.rescheduled",
  "appointment.cancelled": "appointment.cancelled",
  "appointment.no_show": "appointment.no_show",
  "appointment.completed": "appointment.completed",
  "message.inbound": "conversation.inbound",
  "message.outbound": "conversation.outbound",
  "review.received": "review.feedback_received",
  "task.created": "task.created",
  "task.completed": "task.completed",
};

export function activityEventType(entityType: string, action: string): SyncEventType {
  return ACTIVITY_EVENT_TYPES[`${entityType}.${action}`] ?? "system.workflow_event";
}

/** activity_events -> the audit-event shape; `locationId` carries the workspace id from the context. */
export function auditEventRecord(row: NativeActivityRow, workspaceRef: string): AuditEventRecord {
  const id = String(row.id);
  const entity = row.entity_id ?? undefined;
  return {
    id,
    idempotencyKey: `activity-${id}`,
    eventType: activityEventType(row.entity_type, row.action),
    locationId: workspaceRef,
    receivedAt: row.created_at,
    sourceEventName: `${row.entity_type}.${row.action}`,
    entityRefs: {
      contactId: row.entity_type === "contact" ? entity : undefined,
      opportunityId: row.entity_type === "opportunity" ? entity : undefined,
      appointmentId: row.entity_type === "appointment" ? entity : undefined,
    },
  };
}

/** Latest ISO timestamp among the candidates, or undefined when there are none. */
export function latestTimestamp(values: (string | null | undefined)[]): string | undefined {
  let best: { ms: number; iso: string } | undefined;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > best.ms) best = { ms, iso: new Date(ms).toISOString() };
  }
  return best?.iso;
}

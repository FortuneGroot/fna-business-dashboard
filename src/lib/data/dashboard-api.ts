import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  DashboardSummary,
  OpportunityRecord,
} from "@/lib/sync/types";
import type { StorageMode } from "@/lib/sync/store";

/**
 * Pre-migration /api/dashboard/* response shapes (API-1). Both providers build their responses with
 * these mappers, so the JSON contract is identical; only `source` names where the data came from.
 */
export type DashboardMeta = { ok: true; source: "sync-store" | "workspace"; storageMode: StorageMode };

export type ContactRow = {
  id: string;
  displayName: string;
  email?: "[redacted]";
  phone?: "[redacted]";
  hasEmail: boolean;
  hasPhone: boolean;
  source: string;
  tags: string[];
  assignedUser: string;
  updatedAt: string;
};

export type OpportunityRow = {
  id: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  stageName: string;
  status: string;
  monetaryValue: number | null;
  assignedUser: string;
  updatedAt: string;
};

export type AppointmentRow = {
  id: string;
  contactId: string;
  calendarId: string;
  calendarName: string;
  status: string;
  start: string;
  end: string;
  timezone: string;
  assignedUser: string;
  updatedAt: string;
};

export type ConversationRow = {
  id: string;
  contactId: string;
  direction: string;
  channel: string;
  eventType: string;
  timestamp: string;
  summary: string;
};

export type EventRow = {
  id: string;
  eventType: string;
  receivedAt: string;
  locationId: string;
  entityRefs: AuditEventRecord["entityRefs"];
  note: string;
};

export type SummaryResponse = DashboardMeta & { summary: DashboardSummary };
export type ContactsResponse = DashboardMeta & { contacts: ContactRow[]; waitingForSync: boolean };
export type OpportunitiesResponse = DashboardMeta & { opportunities: OpportunityRow[]; waitingForSync: boolean };
export type AppointmentsResponse = DashboardMeta & { appointments: AppointmentRow[]; waitingForSync: boolean };
export type ConversationsResponse = DashboardMeta & { conversations: ConversationRow[]; waitingForSync: boolean };
export type EventsResponse = DashboardMeta & { events: EventRow[]; waitingForSync: boolean };

export function contactRow(c: ContactRecord): ContactRow {
  return {
    id: c.externalContactId,
    displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" ") || "—",
    email: c.email ? "[redacted]" : undefined,
    phone: c.phone ? "[redacted]" : undefined,
    hasEmail: Boolean(c.email),
    hasPhone: Boolean(c.phone),
    source: c.source || "—",
    tags: c.tags,
    assignedUser: c.assignedUser || "—",
    updatedAt: c.updatedAt,
  };
}

export function opportunityRow(o: OpportunityRecord): OpportunityRow {
  return {
    id: o.externalOpportunityId,
    contactId: o.contactId || "—",
    pipelineId: o.pipelineId || "—",
    stageId: o.stageId || "—",
    stageName: o.stageName || "—",
    status: o.status || "—",
    monetaryValue: o.monetaryValue ?? null,
    assignedUser: o.assignedUser || "—",
    updatedAt: o.updatedAt,
  };
}

export function appointmentRow(a: AppointmentRecord): AppointmentRow {
  return {
    id: a.externalAppointmentId,
    contactId: a.contactId || "—",
    calendarId: a.calendarId || "—",
    calendarName: a.calendarName || "—",
    status: a.status || "—",
    start: a.start || "—",
    end: a.end || "—",
    timezone: a.timezone || "—",
    assignedUser: a.assignedUser || "—",
    updatedAt: a.updatedAt,
  };
}

export function conversationRow(c: ConversationEventRecord): ConversationRow {
  return {
    id: c.id,
    contactId: c.contactId || "—",
    direction: c.direction || "unknown",
    channel: c.channel || "—",
    eventType: c.eventType,
    timestamp: c.timestamp,
    summary: c.summary || "—",
  };
}

export function eventRow(e: AuditEventRecord): EventRow {
  return {
    id: e.id,
    eventType: e.eventType,
    receivedAt: e.receivedAt,
    locationId: e.locationId,
    entityRefs: e.entityRefs,
    note: e.note || "—",
  };
}

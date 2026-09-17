import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  DashboardSummary,
  OpportunityRecord,
  ReviewEventRecord,
  SyncSnapshot,
  TaskEventRecord,
} from "./types";

export type SyncStoreStats = {
  contactsSynced: number;
  opportunitiesSynced: number;
  appointmentsSynced: number;
  conversationEvents: number;
  taskEvents: number;
  reviewEvents: number;
  auditEvents: number;
  lastEventAt?: string;
};

export interface SyncStore {
  hasIdempotencyKey(key: string): boolean;
  rememberIdempotencyKey(key: string): void;
  upsertContact(record: ContactRecord): ContactRecord;
  upsertOpportunity(record: OpportunityRecord): OpportunityRecord;
  upsertAppointment(record: AppointmentRecord): AppointmentRecord;
  appendConversationEvent(record: ConversationEventRecord): void;
  appendTaskEvent(record: TaskEventRecord): void;
  appendReviewEvent(record: ReviewEventRecord): void;
  appendAudit(record: AuditEventRecord): void;
  listContacts(): ContactRecord[];
  listOpportunities(): OpportunityRecord[];
  listAppointments(): AppointmentRecord[];
  listConversationEvents(limit?: number): ConversationEventRecord[];
  listAuditEvents(limit?: number): AuditEventRecord[];
  getContact(id: string): ContactRecord | undefined;
  getOpportunity(id: string): OpportunityRecord | undefined;
  getAppointment(id: string): AppointmentRecord | undefined;
  summary(): DashboardSummary;
  stats(): SyncStoreStats;
  snapshot(): SyncSnapshot;
  clear(): void;
}

export function emptySnapshot(): SyncSnapshot {
  return {
    contacts: {},
    opportunities: {},
    appointments: {},
    conversationEvents: [],
    taskEvents: [],
    reviewEvents: [],
    auditTrail: [],
    idempotencyKeys: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export function summaryFromSnapshot(s: SyncSnapshot): DashboardSummary {
  const opps = Object.values(s.opportunities);
  const openValue = opps
    .filter((o) => {
      const st = (o.status || o.stageName || "").toLowerCase();
      return st !== "won" && st !== "lost";
    })
    .reduce((sum, o) => sum + (Number(o.monetaryValue) || 0), 0);
  const wonCount = opps.filter((o) => {
    const st = (o.status || o.stageName || "").toLowerCase();
    return st === "won";
  }).length;
  const contactsCount = Object.keys(s.contacts).length;
  const opportunitiesCount = opps.length;
  const appointmentsCount = Object.keys(s.appointments).length;
  const conversationEventsCount = s.conversationEvents.length;
  return {
    contactsCount,
    opportunitiesCount,
    appointmentsCount,
    conversationEventsCount,
    openPipelineValue: openValue,
    wonCount,
    lastEventAt: s.lastEventAt,
    waitingForSync:
      contactsCount + opportunitiesCount + appointmentsCount + conversationEventsCount === 0,
  };
}

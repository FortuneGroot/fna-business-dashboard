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

export type StorageMode = "memory" | "postgres";

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

/** Durable or in-memory sync persistence. All methods are async for Postgres compatibility. */
export interface SyncStore {
  readonly storageMode: StorageMode;
  hasIdempotencyKey(key: string): Promise<boolean>;
  rememberIdempotencyKey(key: string): Promise<void>;
  upsertContact(record: ContactRecord): Promise<ContactRecord>;
  upsertOpportunity(record: OpportunityRecord): Promise<OpportunityRecord>;
  upsertAppointment(record: AppointmentRecord): Promise<AppointmentRecord>;
  appendConversationEvent(record: ConversationEventRecord): Promise<void>;
  appendTaskEvent(record: TaskEventRecord): Promise<void>;
  appendReviewEvent(record: ReviewEventRecord): Promise<void>;
  appendAudit(record: AuditEventRecord): Promise<void>;
  listContacts(): Promise<ContactRecord[]>;
  listOpportunities(): Promise<OpportunityRecord[]>;
  listAppointments(): Promise<AppointmentRecord[]>;
  listConversationEvents(limit?: number): Promise<ConversationEventRecord[]>;
  listTaskEvents(limit?: number): Promise<TaskEventRecord[]>;
  listReviewEvents(limit?: number): Promise<ReviewEventRecord[]>;
  listAuditEvents(limit?: number): Promise<AuditEventRecord[]>;
  getContact(id: string): Promise<ContactRecord | undefined>;
  getOpportunity(id: string): Promise<OpportunityRecord | undefined>;
  getAppointment(id: string): Promise<AppointmentRecord | undefined>;
  summary(): Promise<DashboardSummary>;
  stats(): Promise<SyncStoreStats>;
  snapshot(): Promise<SyncSnapshot>;
  clear(): Promise<void>;
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

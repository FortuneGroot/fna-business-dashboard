/**
 * Read-only view of the frozen legacy `sync_*` tables (AUTH_PROVIDER=legacy only). Webhook ingestion was
 * retired in P7, so nothing writes these rows any more; they are dropped by M15 after T6.
 */
import "server-only";
import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  DashboardSummary,
  OpportunityRecord,
  ReviewEventRecord,
  StorageMode,
  SyncEventType,
  TaskEventRecord,
} from "@/lib/data/records";
import { legacyPartition } from "./deployment";
import { createLegacyRestClient, isSupabaseConfigured, type LegacyDb } from "./rest-client";

export interface LegacySnapshotStore {
  readonly storageMode: StorageMode;
  listContacts(): Promise<ContactRecord[]>;
  listOpportunities(): Promise<OpportunityRecord[]>;
  listAppointments(): Promise<AppointmentRecord[]>;
  listConversationEvents(limit?: number): Promise<ConversationEventRecord[]>;
  listTaskEvents(limit?: number): Promise<TaskEventRecord[]>;
  listReviewEvents(limit?: number): Promise<ReviewEventRecord[]>;
  listAuditEvents(limit?: number): Promise<AuditEventRecord[]>;
  summary(): Promise<DashboardSummary>;
}

export type LegacySnapshot = {
  contacts: ContactRecord[];
  opportunities: OpportunityRecord[];
  appointments: AppointmentRecord[];
  conversationEvents: ConversationEventRecord[];
  taskEvents: TaskEventRecord[];
  reviewEvents: ReviewEventRecord[];
  auditTrail: AuditEventRecord[];
};

export function summarize(s: Pick<LegacySnapshot, "contacts" | "opportunities" | "appointments" | "conversationEvents">,
  lastEventAt?: string): DashboardSummary {
  const stateOf = (o: OpportunityRecord) => (o.status || o.stageName || "").toLowerCase();
  const openPipelineValue = s.opportunities
    .filter((o) => stateOf(o) !== "won" && stateOf(o) !== "lost")
    .reduce((sum, o) => sum + (Number(o.monetaryValue) || 0), 0);
  const counts = [s.contacts.length, s.opportunities.length, s.appointments.length, s.conversationEvents.length];
  return {
    contactsCount: counts[0],
    opportunitiesCount: counts[1],
    appointmentsCount: counts[2],
    conversationEventsCount: counts[3],
    openPipelineValue,
    wonCount: s.opportunities.filter((o) => stateOf(o) === "won").length,
    lastEventAt,
    waitingForSync: counts.every((n) => n === 0),
  };
}

const newest = <T>(rows: T[], key: (r: T) => string | undefined) =>
  [...rows].sort((a, b) => String(key(b) ?? "").localeCompare(String(key(a) ?? "")));

/** A fixed in-memory snapshot (local runs without a database, and tests). */
export function createMemorySnapshotStore(seed: Partial<LegacySnapshot> = {}): LegacySnapshotStore {
  const s: LegacySnapshot = {
    contacts: seed.contacts ?? [],
    opportunities: seed.opportunities ?? [],
    appointments: seed.appointments ?? [],
    conversationEvents: seed.conversationEvents ?? [],
    taskEvents: seed.taskEvents ?? [],
    reviewEvents: seed.reviewEvents ?? [],
    auditTrail: seed.auditTrail ?? [],
  };
  return {
    storageMode: "memory",
    listContacts: async () => newest(s.contacts, (r) => r.updatedAt),
    listOpportunities: async () => newest(s.opportunities, (r) => r.updatedAt),
    listAppointments: async () => newest(s.appointments, (r) => r.start),
    listConversationEvents: async (limit = 100) => newest(s.conversationEvents, (r) => r.timestamp).slice(0, limit),
    listTaskEvents: async (limit = 100) => newest(s.taskEvents, (r) => r.timestamp).slice(0, limit),
    listReviewEvents: async (limit = 100) => newest(s.reviewEvents, (r) => r.timestamp).slice(0, limit),
    listAuditEvents: async (limit = 100) => newest(s.auditTrail, (r) => r.receivedAt).slice(0, limit),
    summary: async () => summarize(s, newest(s.auditTrail, (r) => r.receivedAt)[0]?.receivedAt),
  };
}

function asStr(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v);
  return s ? s : undefined;
}

function asNum(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** Reads the legacy tables for one partition; every query is filtered by it. */
export function createPostgresSnapshotStore(db: LegacyDb, partition: string): LegacySnapshotStore {
  const scope = { location_id: partition };
  const newestFirst = (column: string, limit?: number) => ({ eq: scope, order: { column, ascending: false }, limit });

  async function tagsOf(contactUuid: string): Promise<string[]> {
    const rows = await db.select("sync_contact_tags", { columns: "tag", eq: { contact_id: contactUuid } });
    return rows.map((r) => String(r.tag)).filter(Boolean);
  }

  const store: LegacySnapshotStore = {
    storageMode: "postgres",

    async listContacts() {
      const rows = await db.select("sync_contacts", newestFirst("updated_at"));
      const out: ContactRecord[] = [];
      for (const row of rows) {
        out.push({
          externalContactId: String(row.external_contact_id),
          firstName: asStr(row.first_name),
          lastName: asStr(row.last_name),
          displayName: asStr(row.display_name),
          email: asStr(row.email),
          phone: asStr(row.phone),
          source: asStr(row.source),
          tags: await tagsOf(String(row.id)),
          assignedUser: asStr(row.assigned_user_id),
          createdAt: asStr(row.created_at),
          updatedAt: asStr(row.updated_at) || new Date().toISOString(),
        });
      }
      return out;
    },

    async listOpportunities() {
      const rows = await db.select("sync_opportunities", newestFirst("updated_at"));
      return rows.map((row) => ({
        externalOpportunityId: String(row.external_opportunity_id),
        contactId: asStr(row.external_contact_id),
        pipelineId: asStr(row.pipeline_id),
        stageId: asStr(row.stage_id),
        stageName: asStr(row.stage_name),
        status: asStr(row.status),
        monetaryValue: asNum(row.monetary_value),
        assignedUser: asStr(row.assigned_user_id),
        createdAt: asStr(row.created_at),
        updatedAt: asStr(row.updated_at) || new Date().toISOString(),
      }));
    },

    async listAppointments() {
      const rows = await db.select("sync_appointments", newestFirst("start_at"));
      return rows.map((row) => ({
        externalAppointmentId: String(row.external_appointment_id),
        contactId: asStr(row.external_contact_id),
        calendarId: asStr(row.calendar_id),
        calendarName: asStr(row.calendar_name),
        status: asStr(row.status),
        start: asStr(row.start_at),
        end: asStr(row.end_at),
        timezone: asStr(row.timezone),
        assignedUser: asStr(row.assigned_user_id),
        createdAt: asStr(row.created_at),
        updatedAt: asStr(row.updated_at) || new Date().toISOString(),
      }));
    },

    async listConversationEvents(limit = 100) {
      const rows = await db.select("sync_conversation_events", newestFirst("occurred_at", limit));
      return rows.map((r) => ({
        id: String(r.id),
        contactId: asStr(r.external_contact_id),
        direction: (asStr(r.direction) as ConversationEventRecord["direction"]) || "unknown",
        channel: asStr(r.channel),
        eventType: String(r.event_type),
        timestamp: asStr(r.occurred_at) || new Date().toISOString(),
        summary: asStr(r.summary),
      }));
    },

    async listTaskEvents(limit = 100) {
      const rows = await db.select("sync_tasks", newestFirst("occurred_at", limit));
      return rows.map((r) => ({
        id: String(r.id),
        contactId: asStr(r.external_contact_id),
        opportunityId: asStr(r.external_opportunity_id),
        type: asStr(r.task_type),
        status: asStr(r.status),
        assignedUser: asStr(r.assigned_user_id),
        timestamp: asStr(r.occurred_at) || new Date().toISOString(),
      }));
    },

    async listReviewEvents(limit = 100) {
      const rows = await db.select("sync_review_events", newestFirst("occurred_at", limit));
      return rows.map((r) => ({
        id: String(r.id),
        contactId: asStr(r.external_contact_id),
        kind: (asStr(r.kind) as ReviewEventRecord["kind"]) || "review-requested",
        resultStatus: asStr(r.result_status),
        timestamp: asStr(r.occurred_at) || new Date().toISOString(),
      }));
    },

    async listAuditEvents(limit = 100) {
      const rows = await db.select("sync_events", newestFirst("received_at", limit));
      return rows.map((r) => ({
        id: String(r.id),
        idempotencyKey: String(r.idempotency_key),
        eventType: String(r.event_type) as SyncEventType,
        locationId: String(r.location_id),
        receivedAt: asStr(r.received_at) || new Date().toISOString(),
        sourceEventName: asStr(r.source_event_name),
        entityRefs: {
          contactId: asStr(r.external_contact_id),
          opportunityId: asStr(r.external_opportunity_id),
          appointmentId: asStr(r.external_appointment_id),
        },
        note: asStr(r.note),
      }));
    },

    async summary() {
      const [contacts, opportunities, appointments, conversationEvents, audit] = await Promise.all([
        store.listContacts(),
        store.listOpportunities(),
        store.listAppointments(),
        store.listConversationEvents(500),
        store.listAuditEvents(1),
      ]);
      return summarize({ contacts, opportunities, appointments, conversationEvents }, audit[0]?.receivedAt);
    },
  };
  return store;
}

const GLOBAL_KEY = "__fna_legacy_snapshot__";
type GlobalStore = typeof globalThis & { [GLOBAL_KEY]?: LegacySnapshotStore };

export function createLegacySnapshotStore(env: NodeJS.ProcessEnv = process.env): LegacySnapshotStore {
  return isSupabaseConfigured(env)
    ? createPostgresSnapshotStore(createLegacyRestClient(env), legacyPartition(env))
    : createMemorySnapshotStore();
}

export function getLegacySnapshotStore(): LegacySnapshotStore {
  const g = globalThis as GlobalStore;
  g[GLOBAL_KEY] ??= createLegacySnapshotStore();
  return g[GLOBAL_KEY];
}

export function resetLegacySnapshotStoreForTests(store?: LegacySnapshotStore): void {
  const g = globalThis as GlobalStore;
  g[GLOBAL_KEY] = store;
}

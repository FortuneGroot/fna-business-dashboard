import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  OpportunityRecord,
  ReviewEventRecord,
  SyncSnapshot,
  TaskEventRecord,
} from "./types";
import {
  emptySnapshot,
  summaryFromSnapshot,
  type SyncStore,
  type SyncStoreStats,
} from "./store";

const AUDIT_MAX = 500;
const CONVO_MAX = 500;
const IDEMP_MAX = 2000;

function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function createMemoryStore(seed?: SyncSnapshot): SyncStore {
  const state: SyncSnapshot = seed ? structuredClone(seed) : emptySnapshot();

  const touch = (iso?: string) => {
    const ts = iso || new Date().toISOString();
    state.updatedAt = ts;
    if (!state.lastEventAt || ts > state.lastEventAt) state.lastEventAt = ts;
  };

  return {
    storageMode: "memory",

    async hasIdempotencyKey(key: string) {
      return state.idempotencyKeys.includes(key);
    },
    async rememberIdempotencyKey(key: string) {
      if (!state.idempotencyKeys.includes(key)) {
        state.idempotencyKeys.unshift(key);
        if (state.idempotencyKeys.length > IDEMP_MAX) state.idempotencyKeys.pop();
      }
    },
    async upsertContact(record) {
      const prev = state.contacts[record.externalContactId];
      const patch = definedOnly(record as unknown as Record<string, unknown>);
      const next: ContactRecord = {
        ...prev,
        ...patch,
        externalContactId: record.externalContactId,
        tags: record.tags?.length ? record.tags : prev?.tags || [],
        updatedAt: record.updatedAt || new Date().toISOString(),
      };
      state.contacts[record.externalContactId] = next;
      touch(next.updatedAt);
      return next;
    },
    async upsertOpportunity(record) {
      const prev = state.opportunities[record.externalOpportunityId];
      const patch = definedOnly(record as unknown as Record<string, unknown>);
      const next: OpportunityRecord = {
        ...prev,
        ...patch,
        externalOpportunityId: record.externalOpportunityId,
        updatedAt: record.updatedAt || new Date().toISOString(),
      };
      state.opportunities[record.externalOpportunityId] = next;
      touch(next.updatedAt);
      return next;
    },
    async upsertAppointment(record) {
      const prev = state.appointments[record.externalAppointmentId];
      const patch = definedOnly(record as unknown as Record<string, unknown>);
      const next: AppointmentRecord = {
        ...prev,
        ...patch,
        externalAppointmentId: record.externalAppointmentId,
        updatedAt: record.updatedAt || new Date().toISOString(),
      };
      state.appointments[record.externalAppointmentId] = next;
      touch(next.updatedAt);
      return next;
    },
    async appendConversationEvent(record: ConversationEventRecord) {
      state.conversationEvents.unshift(record);
      if (state.conversationEvents.length > CONVO_MAX) state.conversationEvents.pop();
      touch(record.timestamp);
    },
    async appendTaskEvent(record: TaskEventRecord) {
      state.taskEvents.unshift(record);
      if (state.taskEvents.length > CONVO_MAX) state.taskEvents.pop();
      touch(record.timestamp);
    },
    async appendReviewEvent(record: ReviewEventRecord) {
      state.reviewEvents.unshift(record);
      if (state.reviewEvents.length > CONVO_MAX) state.reviewEvents.pop();
      touch(record.timestamp);
    },
    async appendAudit(record: AuditEventRecord) {
      state.auditTrail.unshift(record);
      if (state.auditTrail.length > AUDIT_MAX) state.auditTrail.pop();
      touch(record.receivedAt);
    },
    async listContacts() {
      return Object.values(state.contacts).sort((a, b) =>
        (b.updatedAt || "").localeCompare(a.updatedAt || "")
      );
    },
    async listOpportunities() {
      return Object.values(state.opportunities).sort((a, b) =>
        (b.updatedAt || "").localeCompare(a.updatedAt || "")
      );
    },
    async listAppointments() {
      return Object.values(state.appointments).sort((a, b) =>
        (b.start || b.updatedAt || "").localeCompare(a.start || a.updatedAt || "")
      );
    },
    async listConversationEvents(limit = 100) {
      return state.conversationEvents.slice(0, limit);
    },
    async listAuditEvents(limit = 100) {
      return state.auditTrail.slice(0, limit);
    },
    async getContact(id) {
      return state.contacts[id];
    },
    async getOpportunity(id) {
      return state.opportunities[id];
    },
    async getAppointment(id) {
      return state.appointments[id];
    },
    async summary() {
      return summaryFromSnapshot(state);
    },
    async stats(): Promise<SyncStoreStats> {
      return {
        contactsSynced: Object.keys(state.contacts).length,
        opportunitiesSynced: Object.keys(state.opportunities).length,
        appointmentsSynced: Object.keys(state.appointments).length,
        conversationEvents: state.conversationEvents.length,
        taskEvents: state.taskEvents.length,
        reviewEvents: state.reviewEvents.length,
        auditEvents: state.auditTrail.length,
        lastEventAt: state.lastEventAt,
      };
    },
    async snapshot() {
      return structuredClone(state);
    },
    async clear() {
      const empty = emptySnapshot();
      Object.assign(state, empty);
      state.contacts = {};
      state.opportunities = {};
      state.appointments = {};
      state.conversationEvents = [];
      state.taskEvents = [];
      state.reviewEvents = [];
      state.auditTrail = [];
      state.idempotencyKeys = [];
      delete state.lastEventAt;
    },
  };
}

import type {
  AppointmentRecord,
  AuditEventRecord,
  ContactRecord,
  ConversationEventRecord,
  OpportunityRecord,
  ReviewEventRecord,
  SyncSnapshot,
  TaskEventRecord,
  SyncEventType,
} from "./types";
import { summaryFromSnapshot, type SyncStore, type SyncStoreStats } from "./store";
import type { SyncDb } from "./db-client";
import { assertAllowedLocationId } from "./location-guard";

function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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

export function createPostgresStore(db: SyncDb, locationIdInput: string): SyncStore {
  const locationId = assertAllowedLocationId(locationIdInput);

  async function loadContactTags(contactUuid: string): Promise<string[]> {
    const rows = await db.select("sync_contact_tags", {
      columns: "tag",
      eq: { contact_id: contactUuid },
    });
    return rows.map((r) => String(r.tag)).filter(Boolean);
  }

  function mapContact(row: Record<string, unknown>, tags: string[]): ContactRecord {
    return {
      externalContactId: String(row.external_contact_id),
      firstName: asStr(row.first_name),
      lastName: asStr(row.last_name),
      displayName: asStr(row.display_name),
      email: asStr(row.email),
      phone: asStr(row.phone),
      source: asStr(row.source),
      tags,
      assignedUser: asStr(row.assigned_user_id),
      createdAt: asStr(row.created_at),
      updatedAt: asStr(row.updated_at) || new Date().toISOString(),
    };
  }

  function mapOpportunity(row: Record<string, unknown>): OpportunityRecord {
    return {
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
    };
  }

  function mapAppointment(row: Record<string, unknown>): AppointmentRecord {
    return {
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
    };
  }

  return {
    storageMode: "postgres",

    async hasIdempotencyKey(key: string) {
      const rows = await db.select("sync_idempotency", {
        columns: "idempotency_key",
        eq: { location_id: locationId, idempotency_key: key },
        limit: 1,
      });
      return rows.length > 0;
    },

    async rememberIdempotencyKey(key: string) {
      await db.upsert(
        "sync_idempotency",
        {
          location_id: locationId,
          idempotency_key: key,
          created_at: new Date().toISOString(),
        },
        "location_id,idempotency_key"
      );
    },

    async upsertContact(record) {
      const now = record.updatedAt || new Date().toISOString();
      const existing = await db.select("sync_contacts", {
        eq: { location_id: locationId, external_contact_id: record.externalContactId },
        limit: 1,
      });
      const prev = existing[0];
      const patch = definedOnly({
        first_name: record.firstName,
        last_name: record.lastName,
        display_name: record.displayName,
        email: record.email,
        phone: record.phone,
        source: record.source,
        assigned_user_id: record.assignedUser,
      });
      const row = await db.upsert(
        "sync_contacts",
        {
          ...(prev || {}),
          location_id: locationId,
          external_contact_id: record.externalContactId,
          ...patch,
          created_at: asStr(prev?.created_at) || record.createdAt || now,
          updated_at: now,
          synced_at: now,
        },
        "location_id,external_contact_id"
      );

      const contactUuid = String(row.id);
      if (record.tags?.length) {
        await db.delete("sync_contact_tags", { contact_id: contactUuid });
        await db.insertMany(
          "sync_contact_tags",
          record.tags.map((tag) => ({ contact_id: contactUuid, tag }))
        );
      }
      const tags = record.tags?.length
        ? record.tags
        : prev
          ? await loadContactTags(contactUuid)
          : [];
      return mapContact(row, tags);
    },

    async upsertOpportunity(record) {
      const now = record.updatedAt || new Date().toISOString();
      const existing = await db.select("sync_opportunities", {
        eq: {
          location_id: locationId,
          external_opportunity_id: record.externalOpportunityId,
        },
        limit: 1,
      });
      const prev = existing[0];
      const patch = definedOnly({
        external_contact_id: record.contactId,
        pipeline_id: record.pipelineId,
        stage_id: record.stageId,
        stage_name: record.stageName,
        status: record.status,
        monetary_value: record.monetaryValue,
        assigned_user_id: record.assignedUser,
      });
      const row = await db.upsert(
        "sync_opportunities",
        {
          ...(prev || {}),
          location_id: locationId,
          external_opportunity_id: record.externalOpportunityId,
          ...patch,
          created_at: asStr(prev?.created_at) || record.createdAt || now,
          updated_at: now,
          synced_at: now,
        },
        "location_id,external_opportunity_id"
      );
      return mapOpportunity(row);
    },

    async upsertAppointment(record) {
      const now = record.updatedAt || new Date().toISOString();
      const existing = await db.select("sync_appointments", {
        eq: {
          location_id: locationId,
          external_appointment_id: record.externalAppointmentId,
        },
        limit: 1,
      });
      const prev = existing[0];
      const patch = definedOnly({
        external_contact_id: record.contactId,
        calendar_id: record.calendarId,
        calendar_name: record.calendarName,
        status: record.status,
        start_at: record.start,
        end_at: record.end,
        timezone: record.timezone,
        assigned_user_id: record.assignedUser,
      });
      const row = await db.upsert(
        "sync_appointments",
        {
          ...(prev || {}),
          location_id: locationId,
          external_appointment_id: record.externalAppointmentId,
          ...patch,
          created_at: asStr(prev?.created_at) || record.createdAt || now,
          updated_at: now,
          synced_at: now,
        },
        "location_id,external_appointment_id"
      );
      return mapAppointment(row);
    },

    async appendConversationEvent(record) {
      await db.insert("sync_conversation_events", {
        id: record.id,
        location_id: locationId,
        external_contact_id: record.contactId,
        direction: record.direction,
        channel: record.channel,
        event_type: record.eventType,
        summary: record.summary,
        occurred_at: record.timestamp,
        synced_at: new Date().toISOString(),
      });
    },

    async appendTaskEvent(record) {
      await db.insert("sync_tasks", {
        id: record.id,
        location_id: locationId,
        external_contact_id: record.contactId,
        external_opportunity_id: record.opportunityId,
        task_type: record.type,
        status: record.status,
        assigned_user_id: record.assignedUser,
        occurred_at: record.timestamp,
        synced_at: new Date().toISOString(),
      });
    },

    async appendReviewEvent(record) {
      await db.insert("sync_review_events", {
        id: record.id,
        location_id: locationId,
        external_contact_id: record.contactId,
        kind: record.kind,
        result_status: record.resultStatus,
        occurred_at: record.timestamp,
        synced_at: new Date().toISOString(),
      });
    },

    async appendAudit(record) {
      await db.insert("sync_events", {
        id: record.id,
        location_id: locationId,
        idempotency_key: record.idempotencyKey,
        event_type: record.eventType,
        source_event_name: record.sourceEventName,
        external_contact_id: record.entityRefs.contactId,
        external_opportunity_id: record.entityRefs.opportunityId,
        external_appointment_id: record.entityRefs.appointmentId,
        note: record.note,
        received_at: record.receivedAt,
      });
    },

    async listContacts() {
      const rows = await db.select("sync_contacts", {
        eq: { location_id: locationId },
        order: { column: "updated_at", ascending: false },
      });
      const out: ContactRecord[] = [];
      for (const row of rows) {
        const tags = await loadContactTags(String(row.id));
        out.push(mapContact(row, tags));
      }
      return out;
    },

    async listOpportunities() {
      const rows = await db.select("sync_opportunities", {
        eq: { location_id: locationId },
        order: { column: "updated_at", ascending: false },
      });
      return rows.map(mapOpportunity);
    },

    async listAppointments() {
      const rows = await db.select("sync_appointments", {
        eq: { location_id: locationId },
        order: { column: "start_at", ascending: false },
      });
      return rows.map(mapAppointment);
    },

    async listConversationEvents(limit = 100) {
      const rows = await db.select("sync_conversation_events", {
        eq: { location_id: locationId },
        order: { column: "occurred_at", ascending: false },
        limit,
      });
      return rows.map(
        (r): ConversationEventRecord => ({
          id: String(r.id),
          contactId: asStr(r.external_contact_id),
          direction: (asStr(r.direction) as ConversationEventRecord["direction"]) || "unknown",
          channel: asStr(r.channel),
          eventType: String(r.event_type),
          timestamp: asStr(r.occurred_at) || new Date().toISOString(),
          summary: asStr(r.summary),
        })
      );
    },

    async listAuditEvents(limit = 100) {
      const rows = await db.select("sync_events", {
        eq: { location_id: locationId },
        order: { column: "received_at", ascending: false },
        limit,
      });
      return rows.map(
        (r): AuditEventRecord => ({
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
        })
      );
    },

    async getContact(id) {
      const rows = await db.select("sync_contacts", {
        eq: { location_id: locationId, external_contact_id: id },
        limit: 1,
      });
      if (!rows[0]) return undefined;
      const tags = await loadContactTags(String(rows[0].id));
      return mapContact(rows[0], tags);
    },

    async getOpportunity(id) {
      const rows = await db.select("sync_opportunities", {
        eq: { location_id: locationId, external_opportunity_id: id },
        limit: 1,
      });
      return rows[0] ? mapOpportunity(rows[0]) : undefined;
    },

    async getAppointment(id) {
      const rows = await db.select("sync_appointments", {
        eq: { location_id: locationId, external_appointment_id: id },
        limit: 1,
      });
      return rows[0] ? mapAppointment(rows[0]) : undefined;
    },

    async summary() {
      const snap = await this.snapshot();
      return summaryFromSnapshot(snap);
    },

    async stats(): Promise<SyncStoreStats> {
      const loc = { location_id: locationId };
      const [
        contactsSynced,
        opportunitiesSynced,
        appointmentsSynced,
        conversationEvents,
        taskEvents,
        reviewEvents,
        auditEvents,
      ] = await Promise.all([
        db.count("sync_contacts", loc),
        db.count("sync_opportunities", loc),
        db.count("sync_appointments", loc),
        db.count("sync_conversation_events", loc),
        db.count("sync_tasks", loc),
        db.count("sync_review_events", loc),
        db.count("sync_events", loc),
      ]);
      const latest = await db.select("sync_events", {
        eq: loc,
        order: { column: "received_at", ascending: false },
        limit: 1,
      });
      return {
        contactsSynced,
        opportunitiesSynced,
        appointmentsSynced,
        conversationEvents,
        taskEvents,
        reviewEvents,
        auditEvents,
        lastEventAt: asStr(latest[0]?.received_at),
      };
    },

    async snapshot(): Promise<SyncSnapshot> {
      const contactsList = await this.listContacts();
      const opps = await this.listOpportunities();
      const appts = await this.listAppointments();
      const conversationEvents = await this.listConversationEvents(500);
      const auditTrail = await this.listAuditEvents(500);
      const taskRows = await db.select("sync_tasks", {
        eq: { location_id: locationId },
        order: { column: "occurred_at", ascending: false },
        limit: 500,
      });
      const reviewRows = await db.select("sync_review_events", {
        eq: { location_id: locationId },
        order: { column: "occurred_at", ascending: false },
        limit: 500,
      });
      const idem = await db.select("sync_idempotency", {
        eq: { location_id: locationId },
        order: { column: "created_at", ascending: false },
        limit: 2000,
      });
      const contacts: SyncSnapshot["contacts"] = {};
      for (const c of contactsList) contacts[c.externalContactId] = c;
      const opportunities: SyncSnapshot["opportunities"] = {};
      for (const o of opps) opportunities[o.externalOpportunityId] = o;
      const appointments: SyncSnapshot["appointments"] = {};
      for (const a of appts) appointments[a.externalAppointmentId] = a;
      const taskEvents: TaskEventRecord[] = taskRows.map((r) => ({
        id: String(r.id),
        contactId: asStr(r.external_contact_id),
        opportunityId: asStr(r.external_opportunity_id),
        type: asStr(r.task_type),
        status: asStr(r.status),
        assignedUser: asStr(r.assigned_user_id),
        timestamp: asStr(r.occurred_at) || new Date().toISOString(),
      }));
      const reviewEvents: ReviewEventRecord[] = reviewRows.map((r) => ({
        id: String(r.id),
        contactId: asStr(r.external_contact_id),
        kind: (asStr(r.kind) as ReviewEventRecord["kind"]) || "review-requested",
        resultStatus: asStr(r.result_status),
        timestamp: asStr(r.occurred_at) || new Date().toISOString(),
      }));
      const lastEventAt = auditTrail[0]?.receivedAt;
      return {
        contacts,
        opportunities,
        appointments,
        conversationEvents,
        taskEvents,
        reviewEvents,
        auditTrail,
        idempotencyKeys: idem.map((r) => String(r.idempotency_key)),
        lastEventAt,
        updatedAt: lastEventAt || new Date().toISOString(),
      };
    },

    async clear() {
      // Test/dev helper only — location-scoped deletes.
      const contacts = await db.select("sync_contacts", { eq: { location_id: locationId } });
      for (const c of contacts) {
        await db.delete("sync_contact_tags", { contact_id: String(c.id) });
      }
      await db.delete("sync_contacts", { location_id: locationId });
      await db.delete("sync_opportunities", { location_id: locationId });
      await db.delete("sync_appointments", { location_id: locationId });
      await db.delete("sync_conversation_events", { location_id: locationId });
      await db.delete("sync_tasks", { location_id: locationId });
      await db.delete("sync_review_events", { location_id: locationId });
      await db.delete("sync_events", { location_id: locationId });
      await db.delete("sync_idempotency", { location_id: locationId });
    },
  };
}

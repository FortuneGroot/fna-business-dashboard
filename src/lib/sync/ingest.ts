import { createHash, randomUUID, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { BRAND } from "@/lib/brand";
import { loadEnv } from "@/lib/env";
import { normalizeEventName } from "./events";
import { getSyncStore } from "./factory";
import type { SyncStore } from "./store";
import type { InboundSyncPayload, SyncEventType } from "./types";

export type IngestResult =
  | {
      ok: true;
      accepted: true;
      processed: boolean;
      duplicate?: boolean;
      eventType?: SyncEventType;
      idempotencyKey?: string;
      message: string;
    }
  | {
      ok: false;
      error: string;
      code:
        | "invalid_json"
        | "malformed"
        | "unknown_event"
        | "master_refused"
        | "wrong_location"
        | "invalid_signature"
        | "secret_required";
      status: number;
    };

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function tagsOf(payload: InboundSyncPayload, contact?: Record<string, unknown>): string[] {
  const raw = payload.tags ?? contact?.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t)).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  }
  return [];
}

function displayName(first?: string, last?: string, name?: string): string | undefined {
  if (name) return name;
  const parts = [first, last].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}

export function computeIdempotencyKey(
  payload: InboundSyncPayload,
  eventType: SyncEventType,
  rawBody: string
): string {
  const explicit = str(
    payload.idempotencyKey,
    payload.idempotency_key,
    payload.eventId,
    payload.event_id
  );
  if (explicit) return explicit;
  const digest = createHash("sha256")
    .update(eventType)
    .update("|")
    .update(str(payload.locationId, payload.location_id) || "")
    .update("|")
    .update(str(payload.contactId, payload.contact_id, asObj(payload.contact)?.id) || "")
    .update("|")
    .update(
      str(payload.opportunityId, payload.opportunity_id, asObj(payload.opportunity)?.id) || ""
    )
    .update("|")
    .update(
      str(payload.appointmentId, payload.appointment_id, asObj(payload.appointment)?.id) || ""
    )
    .update("|")
    .update(str(payload.occurredAt, payload.occurred_at, payload.timestamp) || "")
    .update("|")
    .update(rawBody)
    .digest("hex");
  return `auto:${digest.slice(0, 40)}`;
}

export function resolveLocationId(payload: InboundSyncPayload): string {
  return str(payload.locationId, payload.location_id) || "";
}

export function resolveEventType(payload: InboundSyncPayload): SyncEventType | null {
  return normalizeEventName(
    payload.eventType || payload.event_name || payload.event || payload.type
  );
}

/**
 * Secret policy for $297 webhook ingestion:
 * - If GHL_WEBHOOK_SECRET is configured → always verify header.
 * - If GHL_WEBHOOK_ENFORCE_SECRET=true OR dryRun=false → require a valid secret.
 * - Callers must also set enforceFlag when VERCEL_ENV=production (route does this).
 * - Otherwise (local dry-run without secret) → allow explicit development mode.
 */
export function verifyWebhookSecret(opts: {
  signatureHeader: string;
  dryRun: boolean;
  secretConfigured: boolean;
  secretValue: string;
  enforceFlag: boolean;
}): { ok: true } | { ok: false; code: "invalid_signature" | "secret_required" } {
  const enforce = opts.enforceFlag || !opts.dryRun;
  if (opts.secretConfigured) {
    if (!opts.signatureHeader || !timingSafeEqualStr(opts.signatureHeader, opts.secretValue)) {
      return { ok: false, code: "invalid_signature" };
    }
    return { ok: true };
  }
  if (enforce) return { ok: false, code: "secret_required" };
  return { ok: true };
}

export async function ingestSyncPayload(
  rawBody: string,
  payloadUnknown: unknown,
  opts?: { store?: SyncStore; now?: string }
): Promise<IngestResult> {
  const env = loadEnv();
  const store = opts?.store || getSyncStore();
  const now = opts?.now || new Date().toISOString();

  if (payloadUnknown == null || typeof payloadUnknown !== "object" || Array.isArray(payloadUnknown)) {
    return { ok: false, error: "Malformed payload", code: "malformed", status: 400 };
  }

  const payload = payloadUnknown as InboundSyncPayload;
  const locationId = resolveLocationId(payload);

  if (!locationId) {
    return {
      ok: false,
      error: "locationId is required",
      code: "malformed",
      status: 400,
    };
  }
  if (locationId === BRAND.forbiddenMasterId || locationId === env.forbiddenMasterId) {
    return {
      ok: false,
      error: "Protected Master location refused",
      code: "master_refused",
      status: 409,
    };
  }
  if (locationId !== env.locationId) {
    return {
      ok: false,
      error: "Location not allowed for this dashboard",
      code: "wrong_location",
      status: 403,
    };
  }

  const eventType = resolveEventType(payload);
  if (!eventType) {
    return {
      ok: false,
      error: "Unknown or missing event type",
      code: "unknown_event",
      status: 400,
    };
  }

  const idempotencyKey = computeIdempotencyKey(payload, eventType, rawBody);
  if (await store.hasIdempotencyKey(idempotencyKey)) {
    return {
      ok: true,
      accepted: true,
      processed: false,
      duplicate: true,
      eventType,
      idempotencyKey,
      message: "Duplicate webhook ignored (idempotent).",
    };
  }

  const contactObj = asObj(payload.contact);
  const opportunityObj = asObj(payload.opportunity);
  const appointmentObj = asObj(payload.appointment);
  const conversationObj = asObj(payload.conversation);
  const taskObj = asObj(payload.task);
  const reviewObj = asObj(payload.review);

  const contactId = str(
    payload.contactId,
    payload.contact_id,
    contactObj?.id,
    contactObj?.contactId
  );
  const opportunityId = str(
    payload.opportunityId,
    payload.opportunity_id,
    opportunityObj?.id,
    opportunityObj?.opportunityId
  );
  const appointmentId = str(
    payload.appointmentId,
    payload.appointment_id,
    appointmentObj?.id,
    appointmentObj?.appointmentId
  );

  const occurredAt =
    str(payload.occurredAt, payload.occurred_at, payload.timestamp, now) || now;

  // Contact / lead upsert when identity present
  if (
    contactId &&
    (eventType.startsWith("lead.") ||
      eventType.startsWith("opportunity.") ||
      eventType.startsWith("appointment.") ||
      eventType.startsWith("conversation.") ||
      eventType.startsWith("review.") ||
      eventType.startsWith("task.") ||
      contactObj)
  ) {
    const firstName = str(payload.firstName, contactObj?.firstName, contactObj?.first_name);
    const lastName = str(payload.lastName, contactObj?.lastName, contactObj?.last_name);
    const name = str(payload.name, contactObj?.name, contactObj?.displayName);
    await store.upsertContact({
      externalContactId: contactId,
      firstName,
      lastName,
      displayName: displayName(firstName, lastName, name),
      email: str(payload.email, contactObj?.email),
      phone: str(payload.phone, contactObj?.phone),
      source: str(payload.source, contactObj?.source),
      tags: tagsOf(payload, contactObj),
      assignedUser: str(
        payload.assignedUser,
        payload.assigned_user,
        contactObj?.assignedUser,
        contactObj?.assignedTo
      ),
      createdAt: str(contactObj?.createdAt, contactObj?.dateAdded) || occurredAt,
      updatedAt: occurredAt,
    });
  }

  // Opportunity upsert
  if (
    opportunityId &&
    (eventType.startsWith("opportunity.") || opportunityObj)
  ) {
    let status = str(payload.status, opportunityObj?.status);
    let stageName = str(
      payload.stageName,
      payload.stage_name,
      opportunityObj?.stageName,
      opportunityObj?.pipelineStageName
    );
    if (eventType === "opportunity.won") {
      status = status || "won";
      stageName = stageName || "Won";
    }
    if (eventType === "opportunity.lost") {
      status = status || "lost";
      stageName = stageName || "Lost";
    }
    await store.upsertOpportunity({
      externalOpportunityId: opportunityId,
      contactId,
      pipelineId: str(
        payload.pipelineId,
        payload.pipeline_id,
        opportunityObj?.pipelineId,
        env.pipelineId
      ),
      stageId: str(payload.stageId, payload.stage_id, opportunityObj?.stageId),
      stageName,
      status,
      monetaryValue: num(
        payload.monetaryValue,
        payload.monetary_value,
        opportunityObj?.monetaryValue,
        opportunityObj?.value
      ),
      assignedUser: str(
        payload.assignedUser,
        payload.assigned_user,
        opportunityObj?.assignedUser
      ),
      createdAt: str(opportunityObj?.createdAt) || occurredAt,
      updatedAt: occurredAt,
    });
  }

  // Appointment upsert
  if (appointmentId && (eventType.startsWith("appointment.") || appointmentObj)) {
    let status = str(payload.status, appointmentObj?.status);
    if (eventType === "appointment.booked") status = status || "booked";
    if (eventType === "appointment.rescheduled") status = status || "rescheduled";
    if (eventType === "appointment.cancelled") status = status || "cancelled";
    if (eventType === "appointment.no_show") status = status || "no_show";
    if (eventType === "appointment.completed") status = status || "completed";
    await store.upsertAppointment({
      externalAppointmentId: appointmentId,
      contactId,
      calendarId: str(
        payload.calendarId,
        payload.calendar_id,
        appointmentObj?.calendarId
      ),
      calendarName: str(payload.calendarName, appointmentObj?.calendarName),
      status,
      start: str(payload.start, appointmentObj?.start, appointmentObj?.startTime),
      end: str(payload.end, appointmentObj?.end, appointmentObj?.endTime),
      timezone: str(payload.timezone, appointmentObj?.timezone) || BRAND.timezone,
      assignedUser: str(
        payload.assignedUser,
        payload.assigned_user,
        appointmentObj?.assignedUser
      ),
      createdAt: str(appointmentObj?.createdAt) || occurredAt,
      updatedAt: occurredAt,
    });
  }

  // Conversation event (summary only — no message body replication)
  if (eventType.startsWith("conversation.") || eventType === "lead.reply") {
    const directionRaw = str(
      payload.direction,
      conversationObj?.direction
    )?.toLowerCase();
    const direction =
      directionRaw === "inbound" || directionRaw === "outbound"
        ? directionRaw
        : eventType === "conversation.inbound" || eventType === "lead.reply"
          ? "inbound"
          : eventType === "conversation.outbound"
            ? "outbound"
            : "unknown";
    await store.appendConversationEvent({
      id: randomUUID(),
      contactId,
      direction,
      channel: str(payload.channel, conversationObj?.channel),
      eventType,
      timestamp: occurredAt,
      summary: str(payload.summary, conversationObj?.summary) || eventType,
      metadata: {
        ...(str(payload.workflowName, payload.workflow_name)
          ? { workflowName: str(payload.workflowName, payload.workflow_name)! }
          : {}),
      },
    });
  }

  if (eventType.startsWith("task.")) {
    await store.appendTaskEvent({
      id: randomUUID(),
      contactId,
      opportunityId,
      type: str(payload.type, taskObj?.type) || eventType,
      status:
        str(payload.status, taskObj?.status) ||
        (eventType === "task.completed" ? "completed" : "open"),
      assignedUser: str(payload.assignedUser, payload.assigned_user, taskObj?.assignedUser),
      timestamp: occurredAt,
    });
  }

  if (eventType.startsWith("review.")) {
    await store.appendReviewEvent({
      id: randomUUID(),
      contactId,
      kind: eventType === "review.requested" ? "review-requested" : "feedback-received",
      resultStatus: str(payload.resultStatus, payload.result_status, reviewObj?.resultStatus),
      timestamp: occurredAt,
    });
  }

  await store.rememberIdempotencyKey(idempotencyKey);
  await store.appendAudit({
    id: randomUUID(),
    idempotencyKey,
    eventType,
    locationId,
    receivedAt: now,
    sourceEventName: str(payload.eventType, payload.event_name, payload.event, payload.type),
    entityRefs: { contactId, opportunityId, appointmentId },
    note: "synced",
  });

  return {
    ok: true,
    accepted: true,
    processed: true,
    duplicate: false,
    eventType,
    idempotencyKey,
    message: "Event ingested into normalized sync store.",
  };
}

/** Safe log details — never include email/phone/token/body. */
export function safeIngestLogDetails(result: IngestResult, bytes: number) {
  if (!result.ok) {
    return { bytes, code: result.code, error: result.error };
  }
  return {
    bytes,
    processed: result.processed,
    duplicate: Boolean(result.duplicate),
    eventType: result.eventType,
  };
}

/**
 * Sync foundation tests — Node built-in runner (no paid deps).
 * Run: npm test
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { BRAND } from "../src/lib/brand";
import {
  createMemoryStore,
  ingestSyncPayload,
  normalizeEventName,
  resetSyncStoreForTests,
  summaryFromSnapshot,
  verifyWebhookSecret,
} from "../src/lib/sync";

const LIVE = BRAND.liveLocationId;
const MASTER = BRAND.forbiddenMasterId;

function baseLead(over: Record<string, unknown> = {}) {
  return {
    event: "lead.created",
    locationId: LIVE,
    contactId: "c_test_1",
    firstName: "Test",
    lastName: "Lead",
    source: "website",
    idempotencyKey: "idem-lead-1",
    ...over,
  };
}

beforeEach(() => {
  process.env.GHL_DRY_RUN = "true";
  process.env.ALLOW_PRODUCTION_CONTACT_WRITES = "false";
  process.env.FAKE_CONTACT_ONLY = "true";
  process.env.GHL_LOCATION_ID = LIVE;
  process.env.FORBIDDEN_MASTER_LOCATION_ID = MASTER;
  process.env.GHL_PIPELINE_ID = BRAND.pipelineId;
  delete process.env.GHL_WEBHOOK_SECRET;
  delete process.env.GHL_WEBHOOK_ENFORCE_SECRET;
  resetSyncStoreForTests(createMemoryStore());
});

describe("event aliases", () => {
  it("maps canonical and alias names", () => {
    assert.equal(normalizeEventName("lead.created"), "lead.created");
    assert.equal(normalizeEventName("ContactCreate"), "lead.created");
    assert.equal(normalizeEventName("appointment.noshow"), "appointment.no_show");
  });
});

describe("webhook secret validation", () => {
  it("allows development mode without secret when dry-run", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "",
      dryRun: true,
      secretConfigured: false,
      secretValue: "",
      enforceFlag: false,
    });
    assert.equal(r.ok, true);
  });

  it("rejects when secret configured but header wrong", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "wrong",
      dryRun: true,
      secretConfigured: true,
      secretValue: "correct-secret",
      enforceFlag: false,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "invalid_signature");
  });

  it("accepts matching secret", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "correct-secret",
      dryRun: false,
      secretConfigured: true,
      secretValue: "correct-secret",
      enforceFlag: true,
    });
    assert.equal(r.ok, true);
  });

  it("requires secret when enforcement enabled", () => {
    const r = verifyWebhookSecret({
      signatureHeader: "",
      dryRun: true,
      secretConfigured: false,
      secretValue: "",
      enforceFlag: true,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "secret_required");
  });
});

describe("ingestSyncPayload", () => {
  it("accepts a valid lead.created event", () => {
    const store = createMemoryStore();
    const body = JSON.stringify(baseLead());
    const result = ingestSyncPayload(body, baseLead(), { store });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.processed, true);
      assert.equal(result.eventType, "lead.created");
    }
    assert.equal(store.listContacts().length, 1);
    assert.equal(store.listAuditEvents().length, 1);
  });

  it("ignores duplicate idempotent deliveries", () => {
    const store = createMemoryStore();
    const payload = baseLead({ idempotencyKey: "same-key" });
    const body = JSON.stringify(payload);
    const first = ingestSyncPayload(body, payload, { store });
    const second = ingestSyncPayload(body, payload, { store });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.duplicate, true);
      assert.equal(second.processed, false);
    }
    assert.equal(store.listContacts().length, 1);
    assert.equal(store.listAuditEvents().length, 1);
  });

  it("rejects wrong location", () => {
    const store = createMemoryStore();
    const payload = baseLead({ locationId: "wrong_location_id" });
    const result = ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "wrong_location");
  });

  it("rejects protected Master location", () => {
    const store = createMemoryStore();
    const payload = baseLead({ locationId: MASTER });
    const result = ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "master_refused");
      assert.equal(result.status, 409);
    }
  });

  it("rejects malformed payload (missing location)", () => {
    const store = createMemoryStore();
    const payload = { event: "lead.created", contactId: "c1" };
    const result = ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "malformed");
  });

  it("rejects unknown event type", () => {
    const store = createMemoryStore();
    const payload = { event: "totally.unknown", locationId: LIVE, contactId: "c1" };
    const result = ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown_event");
  });

  it("upserts opportunity stage changes", () => {
    const store = createMemoryStore();
    const created = {
      event: "opportunity.created",
      locationId: LIVE,
      contactId: "c1",
      opportunityId: "o1",
      stageName: "New Lead",
      monetaryValue: 500,
      idempotencyKey: "opp-1",
    };
    ingestSyncPayload(JSON.stringify(created), created, { store });
    const staged = {
      event: "opportunity.stage_changed",
      locationId: LIVE,
      contactId: "c1",
      opportunityId: "o1",
      stageName: "Qualified",
      idempotencyKey: "opp-2",
    };
    ingestSyncPayload(JSON.stringify(staged), staged, { store });
    const opp = store.getOpportunity("o1");
    assert.ok(opp);
    assert.equal(opp!.stageName, "Qualified");
    assert.equal(opp!.monetaryValue, 500);
  });

  it("reschedules appointments via upsert", () => {
    const store = createMemoryStore();
    const booked = {
      event: "appointment.booked",
      locationId: LIVE,
      contactId: "c1",
      appointmentId: "a1",
      start: "2026-09-20T15:00:00Z",
      end: "2026-09-20T15:30:00Z",
      idempotencyKey: "appt-1",
    };
    ingestSyncPayload(JSON.stringify(booked), booked, { store });
    const resched = {
      event: "appointment.rescheduled",
      locationId: LIVE,
      contactId: "c1",
      appointmentId: "a1",
      start: "2026-09-21T16:00:00Z",
      end: "2026-09-21T16:30:00Z",
      idempotencyKey: "appt-2",
    };
    ingestSyncPayload(JSON.stringify(resched), resched, { store });
    const appt = store.getAppointment("a1");
    assert.ok(appt);
    assert.equal(appt!.start, "2026-09-21T16:00:00Z");
    assert.equal(appt!.status, "rescheduled");
  });

  it("keeps an event audit trail", () => {
    const store = createMemoryStore();
    const p1 = baseLead({ idempotencyKey: "a", contactId: "cA" });
    const p2 = baseLead({
      event: "lead.updated",
      idempotencyKey: "b",
      contactId: "cA",
    });
    ingestSyncPayload(JSON.stringify(p1), p1, { store });
    ingestSyncPayload(JSON.stringify(p2), p2, { store });
    const audit = store.listAuditEvents();
    assert.equal(audit.length, 2);
    assert.equal(audit[0].eventType, "lead.updated");
    assert.equal(audit[1].eventType, "lead.created");
  });

  it("reports empty dashboard waiting state", () => {
    const store = createMemoryStore();
    const summary = store.summary();
    assert.equal(summary.waitingForSync, true);
    assert.equal(summary.contactsCount, 0);
    assert.equal(summaryFromSnapshot(store.snapshot()).waitingForSync, true);
  });

  it("does not leak secrets in safe log details path via audit note", () => {
    const store = createMemoryStore();
    const secretish = {
      event: "lead.created",
      locationId: LIVE,
      contactId: "c1",
      idempotencyKey: "no-leak",
      email: "person@example.com",
      GHL_API_TOKEN: "pit-should-never-store-as-token-field",
    };
    ingestSyncPayload(JSON.stringify(secretish), secretish, { store });
    const snap = JSON.stringify(store.snapshot());
    assert.equal(snap.includes("pit-should-never-store-as-token-field"), false);
    // email may be stored on contact for operational use, but audit note must stay non-PII
    assert.equal(store.listAuditEvents()[0].note, "synced");
    assert.equal(store.listAuditEvents()[0].note?.includes("@"), false);
  });
});

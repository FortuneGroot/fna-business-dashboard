/**
 * Sync foundation tests — Node built-in runner (no real Supabase).
 * Run: npm test
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  assertAllowedLocationId,
  createMemoryStore,
  createMockSyncDb,
  createPostgresStore,
  createSyncStore,
  getStorageMode,
  ingestSyncPayload,
  isDatabaseConfigured,
  normalizeEventName,
  rebindSyncStoreFromEnv,
  resetSyncStoreForTests,
  resolveStorageMode,
  summaryFromSnapshot,
  verifyWebhookSecret,
  type SyncStore,
} from "../src/lib/sync";
import {
  FA_LIVE_LOCATION_ID,
  FA_LIVE_PIPELINE_ID,
  faLiveDefaultClientConfig,
  resetTenantConfigForTests,
} from "../src/lib/tenant";
import { PROTECTED_MASTER_LOCATION_ID } from "../src/lib/master-guard";

const LIVE = FA_LIVE_LOCATION_ID;
const MASTER = PROTECTED_MASTER_LOCATION_ID;

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

async function runStoreContract(store: SyncStore, label: string) {
  describe(`${label} store contract`, () => {
    it("upserts contacts and lists them", async () => {
      await store.clear();
      await store.upsertContact({
        externalContactId: "c1",
        firstName: "Ada",
        tags: ["lead-new"],
        updatedAt: "2026-09-17T12:00:00.000Z",
      });
      const list = await store.listContacts();
      assert.equal(list.length, 1);
      assert.equal(list[0].firstName, "Ada");
      assert.deepEqual(list[0].tags, ["lead-new"]);
    });

    it("updates opportunity stage without wiping monetary value", async () => {
      await store.clear();
      await store.upsertOpportunity({
        externalOpportunityId: "o1",
        contactId: "c1",
        stageName: "New Lead",
        monetaryValue: 500,
        updatedAt: "2026-09-17T12:00:00.000Z",
      });
      await store.upsertOpportunity({
        externalOpportunityId: "o1",
        stageName: "Qualified",
        updatedAt: "2026-09-17T13:00:00.000Z",
      });
      const opp = await store.getOpportunity("o1");
      assert.ok(opp);
      assert.equal(opp!.stageName, "Qualified");
      assert.equal(opp!.monetaryValue, 500);
    });

    it("reschedules appointments", async () => {
      await store.clear();
      await store.upsertAppointment({
        externalAppointmentId: "a1",
        contactId: "c1",
        start: "2026-09-20T15:00:00Z",
        status: "booked",
        updatedAt: "2026-09-17T12:00:00.000Z",
      });
      await store.upsertAppointment({
        externalAppointmentId: "a1",
        start: "2026-09-21T16:00:00Z",
        status: "rescheduled",
        updatedAt: "2026-09-17T13:00:00.000Z",
      });
      const appt = await store.getAppointment("a1");
      assert.equal(appt!.start, "2026-09-21T16:00:00Z");
      assert.equal(appt!.status, "rescheduled");
    });

    it("inserts conversation events", async () => {
      await store.clear();
      await store.appendConversationEvent({
        id: "ev1",
        contactId: "c1",
        direction: "inbound",
        channel: "sms",
        eventType: "conversation.inbound",
        timestamp: "2026-09-17T14:00:00.000Z",
        summary: "Customer replied",
      });
      const rows = await store.listConversationEvents();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].summary, "Customer replied");
    });

    it("enforces idempotency keys", async () => {
      await store.clear();
      assert.equal(await store.hasIdempotencyKey("k1"), false);
      await store.rememberIdempotencyKey("k1");
      assert.equal(await store.hasIdempotencyKey("k1"), true);
    });
  });
}

beforeEach(() => {
  process.env.GHL_DRY_RUN = "true";
  process.env.ALLOW_PRODUCTION_CONTACT_WRITES = "false";
  process.env.FAKE_CONTACT_ONLY = "true";
  process.env.GHL_LOCATION_ID = LIVE;
  process.env.FORBIDDEN_MASTER_LOCATION_ID = MASTER;
  process.env.GHL_PIPELINE_ID = FA_LIVE_PIPELINE_ID;
  delete process.env.GHL_WEBHOOK_SECRET;
  delete process.env.GHL_WEBHOOK_ENFORCE_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.CLIENT_CONFIG_PATH;
  resetTenantConfigForTests(faLiveDefaultClientConfig());
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

describe("storage selection", () => {
  it("uses memory when supabase env absent", () => {
    assert.equal(isDatabaseConfigured({}), false);
    assert.equal(resolveStorageMode({}), "memory");
    const store = createSyncStore({ env: { GHL_LOCATION_ID: LIVE } });
    assert.equal(store.storageMode, "memory");
  });

  it("uses postgres when supabase env present", () => {
    const env = {
      GHL_LOCATION_ID: LIVE,
      FORBIDDEN_MASTER_LOCATION_ID: MASTER,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    };
    assert.equal(isDatabaseConfigured(env), true);
    assert.equal(resolveStorageMode(env), "postgres");
    const store = createSyncStore({
      env,
      db: createMockSyncDb(),
      forceMode: "postgres",
    });
    assert.equal(store.storageMode, "postgres");
  });

  it("reports health storageMode after rebind", () => {
    rebindSyncStoreFromEnv({
      GHL_LOCATION_ID: LIVE,
      FORBIDDEN_MASTER_LOCATION_ID: MASTER,
      GHL_PIPELINE_ID: FA_LIVE_PIPELINE_ID,
    });
    assert.equal(getStorageMode(), "memory");
  });
});

describe("location isolation", () => {
  it("rejects Master location ids", () => {
    assert.throws(() => assertAllowedLocationId(MASTER), /Master/);
  });

  it("rejects wrong location ids", () => {
    assert.throws(() => assertAllowedLocationId("other_location"), /not allowed/);
  });

  it("accepts live location", () => {
    assert.equal(assertAllowedLocationId(LIVE), LIVE);
  });
});

runStoreContract(createMemoryStore(), "memory");
runStoreContract(
  createPostgresStore(createMockSyncDb(), LIVE),
  "postgres(mock)"
);

describe("ingestSyncPayload", () => {
  it("accepts a valid lead.created event", async () => {
    const store = createMemoryStore();
    const body = JSON.stringify(baseLead());
    const result = await ingestSyncPayload(body, baseLead(), { store });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.processed, true);
      assert.equal(result.eventType, "lead.created");
    }
    assert.equal((await store.listContacts()).length, 1);
    assert.equal((await store.listAuditEvents()).length, 1);
  });

  it("ignores duplicate idempotent deliveries", async () => {
    const store = createMemoryStore();
    const payload = baseLead({ idempotencyKey: "same-key" });
    const body = JSON.stringify(payload);
    const first = await ingestSyncPayload(body, payload, { store });
    const second = await ingestSyncPayload(body, payload, { store });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.duplicate, true);
      assert.equal(second.processed, false);
    }
    assert.equal((await store.listContacts()).length, 1);
    assert.equal((await store.listAuditEvents()).length, 1);
  });

  it("rejects wrong location", async () => {
    const store = createMemoryStore();
    const payload = baseLead({ locationId: "wrong_location_id" });
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "wrong_location");
  });

  it("rejects protected Master location", async () => {
    const store = createMemoryStore();
    const payload = baseLead({ locationId: MASTER });
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "master_refused");
      assert.equal(result.status, 409);
    }
  });

  it("rejects malformed payload (missing location)", async () => {
    const store = createMemoryStore();
    const payload = { event: "lead.created", contactId: "c1" };
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "malformed");
  });

  it("rejects unknown event type", async () => {
    const store = createMemoryStore();
    const payload = { event: "totally.unknown", locationId: LIVE, contactId: "c1" };
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "unknown_event");
  });

  it("upserts opportunity stage changes via ingest", async () => {
    const store = createPostgresStore(createMockSyncDb(), LIVE);
    const created = {
      event: "opportunity.created",
      locationId: LIVE,
      contactId: "c1",
      opportunityId: "o1",
      stageName: "New Lead",
      monetaryValue: 500,
      idempotencyKey: "opp-1",
    };
    await ingestSyncPayload(JSON.stringify(created), created, { store });
    const staged = {
      event: "opportunity.stage_changed",
      locationId: LIVE,
      contactId: "c1",
      opportunityId: "o1",
      stageName: "Qualified",
      idempotencyKey: "opp-2",
    };
    await ingestSyncPayload(JSON.stringify(staged), staged, { store });
    const opp = await store.getOpportunity("o1");
    assert.ok(opp);
    assert.equal(opp!.stageName, "Qualified");
    assert.equal(opp!.monetaryValue, 500);
  });

  it("reschedules appointments via ingest", async () => {
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
    await ingestSyncPayload(JSON.stringify(booked), booked, { store });
    const resched = {
      event: "appointment.rescheduled",
      locationId: LIVE,
      contactId: "c1",
      appointmentId: "a1",
      start: "2026-09-21T16:00:00Z",
      end: "2026-09-21T16:30:00Z",
      idempotencyKey: "appt-2",
    };
    await ingestSyncPayload(JSON.stringify(resched), resched, { store });
    const appt = await store.getAppointment("a1");
    assert.ok(appt);
    assert.equal(appt!.start, "2026-09-21T16:00:00Z");
    assert.equal(appt!.status, "rescheduled");
  });

  it("keeps an event audit trail", async () => {
    const store = createMemoryStore();
    const p1 = baseLead({ idempotencyKey: "a", contactId: "cA" });
    const p2 = baseLead({
      event: "lead.updated",
      idempotencyKey: "b",
      contactId: "cA",
    });
    await ingestSyncPayload(JSON.stringify(p1), p1, { store });
    await ingestSyncPayload(JSON.stringify(p2), p2, { store });
    const audit = await store.listAuditEvents();
    assert.equal(audit.length, 2);
    assert.equal(audit[0].eventType, "lead.updated");
    assert.equal(audit[1].eventType, "lead.created");
  });

  it("reports empty dashboard waiting state", async () => {
    const store = createMemoryStore();
    const summary = await store.summary();
    assert.equal(summary.waitingForSync, true);
    assert.equal(summary.contactsCount, 0);
    assert.equal(summaryFromSnapshot(await store.snapshot()).waitingForSync, true);
  });

  it("does not leak service role or pit tokens in snapshot/audit", async () => {
    const store = createPostgresStore(createMockSyncDb(), LIVE);
    const secretish = {
      event: "lead.created",
      locationId: LIVE,
      contactId: "c1",
      idempotencyKey: "no-leak",
      email: "person@example.com",
      GHL_API_TOKEN: "pit-should-never-store-as-token-field",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-must-not-persist",
    };
    await ingestSyncPayload(JSON.stringify(secretish), secretish, { store });
    const snap = JSON.stringify(await store.snapshot());
    assert.equal(snap.includes("pit-should-never-store-as-token-field"), false);
    assert.equal(snap.includes("service-role-must-not-persist"), false);
    const audit = await store.listAuditEvents();
    assert.equal(audit[0].note, "synced");
    assert.equal(audit[0].note?.includes("@"), false);
  });
});

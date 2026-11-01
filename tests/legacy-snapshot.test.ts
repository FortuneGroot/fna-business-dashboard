/**
 * P7: the legacy runtime that remains until T6 — a read-only view of the frozen `sync_*` snapshot and the
 * legacy deployment identity. Webhook ingestion, the CRM client, and client-config loading are gone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEGACY_DEFAULT_PARTITION,
  LEGACY_REFUSED_PARTITION,
  legacyBranding,
  legacyPartition,
  legacyWorkspaceView,
} from "../src/lib/legacy/deployment";
import {
  createLegacySnapshotStore,
  createMemorySnapshotStore,
  createPostgresSnapshotStore,
  type LegacySnapshotStore,
} from "../src/lib/legacy/snapshot";
import { createLegacyRestClient, createMockLegacyDb } from "../src/lib/legacy/rest-client";

const A = LEGACY_DEFAULT_PARTITION;
const B = "other-partition";
const READ_SURFACE = [
  "listAppointments", "listAuditEvents", "listContacts", "listConversationEvents", "listOpportunities",
  "listReviewEvents", "listTaskEvents", "storageMode", "summary",
];

function seededDb() {
  const both = <T extends Record<string, unknown>>(row: T) => [
    { ...row, location_id: A },
    { ...row, id: `${String(row.id)}-b`, location_id: B, external_contact_id: "c-b", external_opportunity_id: "o-b" },
  ];
  return createMockLegacyDb({
    sync_contacts: [
      { id: "u1", location_id: A, external_contact_id: "c1", first_name: "Ada", phone: "1", updated_at: "2026-09-17T10:00:00Z" },
      { id: "u2", location_id: A, external_contact_id: "c2", first_name: "Bea", updated_at: "2026-09-18T10:00:00Z" },
      { id: "u3", location_id: B, external_contact_id: "c3", first_name: "Other", updated_at: "2026-09-19T10:00:00Z" },
    ],
    sync_contact_tags: [{ contact_id: "u1", tag: "lead-new" }, { contact_id: "u3", tag: "other" }],
    sync_opportunities: [
      ...both({ id: "o1", external_opportunity_id: "o1", stage_name: "Qualified", monetary_value: "500", updated_at: "2026-09-17T11:00:00Z" }),
      { id: "o2", location_id: A, external_opportunity_id: "o2", status: "won", monetary_value: 900, updated_at: "2026-09-17T12:00:00Z" },
      { id: "o3", location_id: A, external_opportunity_id: "o3", stage_name: "Lost", monetary_value: 50, updated_at: "2026-09-17T09:00:00Z" },
    ],
    sync_appointments: both({ id: "a1", external_appointment_id: "a1", start_at: "2026-09-21T16:00:00Z", status: "rescheduled" }),
    sync_conversation_events: both({ id: "m1", event_type: "conversation.inbound", direction: "inbound", occurred_at: "2026-09-17T14:00:00Z", summary: "Replied" }),
    sync_tasks: both({ id: "t1", task_type: "call", status: "open", assigned_user_id: "user-7", occurred_at: "2026-09-17T15:00:00Z" }),
    sync_review_events: both({ id: "r1", kind: "feedback-received", result_status: "5", occurred_at: "2026-09-17T16:00:00Z" }),
    sync_events: [
      ...both({ id: "e1", idempotency_key: "k1", event_type: "lead.created", received_at: "2026-09-17T10:00:00Z" }),
      { id: "e2", location_id: A, idempotency_key: "k2", event_type: "opportunity.won", received_at: "2026-09-17T12:00:00Z" },
    ],
  });
}

describe("legacy partition", () => {
  it("defaults to the F&A partition and honours an explicit legacy location", () => {
    assert.equal(legacyPartition({}), A);
    assert.equal(legacyPartition({ GHL_LOCATION_ID: "  " }), A);
    assert.equal(legacyPartition({ GHL_LOCATION_ID: " loc-x " }), "loc-x");
  });

  it("refuses the protected Master location, whatever the environment says", () => {
    assert.throws(() => legacyPartition({ GHL_LOCATION_ID: LEGACY_REFUSED_PARTITION }), /Master/);
    assert.throws(
      () => createLegacySnapshotStore({ SUPABASE_URL: "https://db.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", GHL_LOCATION_ID: LEGACY_REFUSED_PARTITION }),
      /Master/
    );
  });
});

describe("legacy snapshot storage selection", () => {
  it("is an empty in-memory snapshot without database credentials", async () => {
    const store = createLegacySnapshotStore({});
    assert.equal(store.storageMode, "memory");
    const summary = await store.summary();
    assert.deepEqual([summary.waitingForSync, summary.contactsCount, summary.lastEventAt], [true, 0, undefined]);
  });

  it("reads the legacy tables when database credentials are present", () => {
    const store = createLegacySnapshotStore({ SUPABASE_URL: "https://db.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
    assert.equal(store.storageMode, "postgres");
  });
});

describe("legacy snapshot reader (postgres over a fixed table set)", () => {
  const store = createPostgresSnapshotStore(seededDb(), A);

  it("returns only its own partition's rows from every table", async () => {
    const all = JSON.stringify([
      await store.listContacts(), await store.listOpportunities(), await store.listAppointments(),
      await store.listConversationEvents(), await store.listTaskEvents(), await store.listReviewEvents(), await store.listAuditEvents(),
    ]);
    assert.equal(all.includes("Other"), false);
    assert.equal(all.includes("-b"), false);
    assert.equal(all.includes(B), false);
  });

  it("maps rows newest first, with tags, numeric values, and assignees", async () => {
    const contacts = await store.listContacts();
    assert.deepEqual(contacts.map((c) => [c.externalContactId, c.tags]), [["c2", []], ["c1", ["lead-new"]]]);
    const opps = await store.listOpportunities();
    assert.deepEqual(opps.map((o) => [o.externalOpportunityId, o.monetaryValue]), [["o2", 900], ["o1", 500], ["o3", 50]]);
    const [appt] = await store.listAppointments();
    assert.deepEqual([appt.start, appt.status], ["2026-09-21T16:00:00Z", "rescheduled"]);
    const [task] = await store.listTaskEvents();
    assert.deepEqual([task.type, task.assignedUser], ["call", "user-7"]);
    const [review] = await store.listReviewEvents();
    assert.deepEqual([review.kind, review.resultStatus], ["feedback-received", "5"]);
    const audit = await store.listAuditEvents();
    assert.deepEqual(audit.map((e) => e.eventType), ["opportunity.won", "lead.created"]);
    assert.equal((await store.listAuditEvents(1)).length, 1);
  });

  it("summarises counts, open value (excluding won and lost), wins, and the last event", async () => {
    assert.deepEqual(await store.summary(), {
      contactsCount: 2, opportunitiesCount: 3, appointmentsCount: 1, conversationEventsCount: 1,
      openPipelineValue: 500, wonCount: 1, lastEventAt: "2026-09-17T12:00:00Z", waitingForSync: false,
    });
  });
});

describe("legacy snapshot is read-only", () => {
  const surface = (s: LegacySnapshotStore) => Object.keys(s).sort();

  it("both readers expose only list and summary operations", () => {
    assert.deepEqual(surface(createMemorySnapshotStore()), READ_SURFACE);
    assert.deepEqual(surface(createPostgresSnapshotStore(createMockLegacyDb(), A)), READ_SURFACE);
  });

  it("the REST client only issues GET and HEAD requests, always filtered, and redacts the key from errors", async () => {
    const original = globalThis.fetch;
    const seen: { method: string; url: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: String(init?.method ?? "GET"), url: String(input) });
      if (String(input).includes("broken")) return new Response("bad key-material-123", { status: 500 });
      return new Response("[]", { status: 200, headers: { "content-range": "0-0/0" } });
    }) as typeof fetch;
    try {
      const db = createLegacyRestClient({ SUPABASE_URL: "https://db.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "key-material-123" });
      assert.deepEqual(Object.keys(db).sort(), ["count", "select"]);
      await createPostgresSnapshotStore(db, A).summary();
      await db.count("sync_contacts", { location_id: A });
      await assert.rejects(() => db.select("broken"), (err: Error) => !err.message.includes("key-material-123"));
      assert.ok(seen.length > 0);
      assert.deepEqual([...new Set(seen.map((r) => r.method))].sort(), ["GET", "HEAD"]);
      for (const r of seen.filter((r) => !r.url.includes("broken") && !r.url.includes("sync_contact_tags"))) {
        assert.ok(r.url.includes(`location_id=eq.${A}`), r.url);
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("legacy in-memory snapshot", () => {
  it("orders seeded rows newest first and applies limits", async () => {
    const store = createMemorySnapshotStore({
      contacts: [
        { externalContactId: "old", tags: [], updatedAt: "2026-09-01T00:00:00Z" },
        { externalContactId: "new", tags: [], updatedAt: "2026-09-02T00:00:00Z" },
      ],
      conversationEvents: [
        { id: "m1", eventType: "conversation.inbound", timestamp: "2026-09-01T00:00:00Z" },
        { id: "m2", eventType: "conversation.outbound", timestamp: "2026-09-03T00:00:00Z" },
      ],
    });
    assert.deepEqual((await store.listContacts()).map((c) => c.externalContactId), ["new", "old"]);
    assert.deepEqual((await store.listConversationEvents(1)).map((e) => e.id), ["m2"]);
    assert.equal((await store.summary()).waitingForSync, false);
  });
});

describe("legacy deployment identity", () => {
  it("matches what the pre-P7 build showed without a client config file", () => {
    const view = legacyWorkspaceView();
    assert.deepEqual([view.businessName, view.legalName, view.timezone], ["Fortune & Automations", "Fortune & Finance LLC", "US/Eastern"]);
    assert.deepEqual(view.stageNames, ["New Lead", "Attempting Contact", "Connected", "Qualified", "Appointment Booked",
      "Appointment Completed", "Estimate / Proposal Sent", "Follow-Up", "Decision Pending", "Won", "Lost", "Long-Term Nurture"]);
    assert.deepEqual(view.calendars.map((c) => [c.id, c.duration]), [
      ["fa-live-cal-discovery-call", "30 min"], ["fa-live-cal-website-consultation", "30 min"],
      ["fa-live-cal-business-consultation", "30 min"], ["fa-live-cal-client-project-meeting", "30 min"],
      ["fa-live-cal-core-booking", "1 hr"],
    ]);
    assert.deepEqual([view.stagesConfigured, view.calendarsConfigured, view.bookingUrl, view.reviewUrl], [true, true, "", ""]);
    assert.equal(view.phone, "781-964-0654", "D7 support phone");
    assert.equal(view.pipelineName, "Fortune & Automations Sales Pipeline");
  });

  it("public branding carries no identifiers", () => {
    const text = JSON.stringify(legacyBranding());
    assert.equal(text.includes(A), false);
    assert.equal(text.includes(LEGACY_REFUSED_PARTITION), false);
    assert.deepEqual(legacyBranding().businessName, "Fortune & Automations");
  });
});

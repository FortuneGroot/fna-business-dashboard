// P3 read parity (spec §9.2): pages and /api/dashboard/* read the active workspace's native tables
// through src/lib/data with the signed-in user's JWT. Route handlers run against the local fake
// Supabase (tests/helpers/fake-supabase.ts), whose table reads apply the RLS rules of M10 (active
// workspace + read permission). Nothing leaves 127.0.0.1. Legacy mode is checked to be unchanged.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { DASHBOARD_ENDPOINTS, dashboardShapeErrors, type DashboardEndpoint } from "./helpers/api-shapes";
import { GET as getSummary } from "../src/app/api/dashboard/summary/route";
import { GET as getContacts } from "../src/app/api/dashboard/contacts/route";
import { GET as getOpportunities } from "../src/app/api/dashboard/opportunities/route";
import { GET as getAppointments } from "../src/app/api/dashboard/appointments/route";
import { GET as getConversations } from "../src/app/api/dashboard/conversations/route";
import { GET as getDashboardEvents } from "../src/app/api/dashboard/events/route";
import { GET as getTenantConfig } from "../src/app/api/tenant/config/route";
import { GET as getTenantPublic } from "../src/app/api/tenant/public/route";
import { GET as getHealth } from "../src/app/api/health/route";
import { GET as getEvents } from "../src/app/api/events/route";
import { GET as getSyncHealth } from "../src/app/api/sync/health/route";
import { GET as getReadiness } from "../src/app/api/onboarding/readiness/route";
import { GET as getGhlHealth } from "../src/app/api/ghl/health/route";
import { POST as postLead } from "../src/app/api/leads/route";
import {
  activityEventType,
  appointmentRecord,
  auditEventRecord,
  contactRecord,
  conversationEventRecord,
  latestTimestamp,
  opportunityRecord,
  reviewEventRecord,
  taskEventRecord,
} from "../src/lib/data/dashboard-adapters";
import { CLIENT_FORBIDDEN_RENDER_TERMS, NATIVE_COPY, SYNC_COPY } from "../src/lib/ui/sync-copy";
import { resetSyncStoreForTests } from "../src/lib/sync";

const ROOT = join(__dirname, "..");
const ENV_KEYS = [
  "AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL", "AUTH_OWNER_PASSWORD", "AUTH_ALLOW_MEMORY_SESSIONS", "VERCEL_ENV", "AUTH_FAIL_CLOSED",
];

const WS_A = "00000000-0000-4000-8000-00000000a0a0";
const WS_B = "00000000-0000-4000-8000-00000000b0b0";
const WS_C = "00000000-0000-4000-8000-00000000c0c0";
const READS = ["dashboard.read", "contacts.read", "pipeline.read", "calendar.read", "conversations.read",
  "tasks.read", "reviews.read", "reports.read", "settings.read", "team.read"];
const OWNER_PERMS = [...READS, "settings.write", "calendar.configure", "onboarding.read", "library.read"];

const ownerA: FakeUser = { id: "00000000-0000-4000-8000-0000000a0001", email: "owner-a@example.invalid", name: "Owner A" };
const ownerB: FakeUser = { id: "00000000-0000-4000-8000-0000000b0001", email: "owner-b@example.invalid", name: "Owner B" };
const limited: FakeUser = { id: "00000000-0000-4000-8000-0000000a0002", email: "limited@example.invalid", name: "Limited" };
const empty: FakeUser = { id: "00000000-0000-4000-8000-0000000c0001", email: "empty@example.invalid", name: "Empty" };
const outsider: FakeUser = { id: "00000000-0000-4000-8000-0000000d0001", email: "outsider@example.invalid", name: "Outsider" };

const ws = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), status: "active" });
const memberCtx = (u: FakeUser, w: ReturnType<typeof ws> | null, role: string | null, permissions: string[]) => ({
  authenticated: true, user_id: u.id, is_platform_admin: false, workspace: w, role, grant: null, permissions,
});

const T = (n: number) => `2026-10-0${n}T12:00:00.000Z`;
const id = (prefix: string, n: number) => `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const cA1 = id("a1", 1), cA2 = id("a1", 2), cB1 = id("b1", 1);
const sA1 = id("a2", 1), sA10 = id("a2", 10), sB1 = id("b2", 1);
const pA = id("a3", 1), pB = id("b3", 1);
const calA = id("a4", 1), calB = id("b4", 1);
const cvA = id("a5", 1), cvB = id("b5", 1);

/** Workspace A's records, plus workspace B's (all B strings contain "bravo" so leaks are detectable). */
function seed(fake: FakeSupabase) {
  fake.seed("workspace_settings", [
    { workspace_id: WS_A, business_name: "Alpha Plumbing", legal_name: "Alpha Plumbing LLC", timezone: "America/Chicago",
      industry: "Plumbing", support_email: "help@alpha.example.invalid", business_phone: "555-0100",
      website_url: "https://alpha.example.invalid", booking_url: "https://alpha.example.invalid/book",
      review_url: "https://alpha.example.invalid/review" },
    { workspace_id: WS_B, business_name: "bravo Moving", legal_name: "", timezone: "America/New_York", industry: "bravo",
      support_email: "bravo@example.invalid", business_phone: null, website_url: null, booking_url: null, review_url: null },
  ]);
  fake.seed("pipelines", [
    { id: pA, workspace_id: WS_A, name: "Sales Pipeline A", is_default: true },
    { id: pB, workspace_id: WS_B, name: "bravo pipeline", is_default: true },
  ]);
  fake.seed("pipeline_stages", [
    { id: sA1, workspace_id: WS_A, pipeline_id: pA, name: "New Lead", position: 1, kind: "open" },
    { id: sA10, workspace_id: WS_A, pipeline_id: pA, name: "Won", position: 10, kind: "won" },
    { id: sB1, workspace_id: WS_B, pipeline_id: pB, name: "bravo stage", position: 1, kind: "open" },
  ]);
  fake.seed("profiles", [{ user_id: ownerA.id, full_name: "Owner A" }]);
  fake.seed("contacts", [
    { id: cA1, workspace_id: WS_A, first_name: "Ada", last_name: "Lovelace", email: "ada@example.invalid", phone: "555-0101",
      source: "website", owner_user_id: ownerA.id, created_at: T(1), updated_at: T(2), deleted_at: null },
    { id: cA2, workspace_id: WS_A, first_name: "Deleted", last_name: "", email: null, phone: "555-0102", source: "manual",
      owner_user_id: null, created_at: T(1), updated_at: T(9), deleted_at: T(9) },
    { id: cB1, workspace_id: WS_B, first_name: "bravo", last_name: "Contact", email: "bravo-c@example.invalid", phone: null,
      source: "bravo", owner_user_id: null, created_at: T(1), updated_at: T(1), deleted_at: null },
  ]);
  fake.seed("contact_tags", [
    { workspace_id: WS_A, contact_id: cA1, tag: "vip" },
    { workspace_id: WS_B, contact_id: cB1, tag: "bravo-tag" },
  ]);
  fake.seed("opportunities", [
    { id: id("a6", 1), workspace_id: WS_A, contact_id: cA1, pipeline_id: pA, stage_id: sA1, status: "open", value_cents: 125050,
      assigned_user_id: ownerA.id, created_at: T(1), updated_at: T(3), deleted_at: null },
    { id: id("a6", 2), workspace_id: WS_A, contact_id: cA1, pipeline_id: pA, stage_id: sA10, status: "won", value_cents: 50000,
      assigned_user_id: null, created_at: T(1), updated_at: T(2), deleted_at: null },
    { id: id("a6", 3), workspace_id: WS_A, contact_id: cA1, pipeline_id: pA, stage_id: sA1, status: "open", value_cents: 99900,
      assigned_user_id: null, created_at: T(1), updated_at: T(9), deleted_at: T(9) },
    { id: id("b6", 1), workspace_id: WS_B, contact_id: cB1, pipeline_id: pB, stage_id: sB1, status: "open", value_cents: 777700,
      assigned_user_id: null, created_at: T(1), updated_at: T(1), deleted_at: null },
  ]);
  fake.seed("calendars", [
    { id: calA, workspace_id: WS_A, name: "Discovery Call", timezone: "America/Chicago", duration_minutes: 30, is_primary: true, active: true },
    { id: calB, workspace_id: WS_B, name: "bravo calendar", timezone: "America/New_York", duration_minutes: 60, is_primary: true, active: true },
  ]);
  fake.seed("appointments", [
    { id: id("a7", 1), workspace_id: WS_A, calendar_id: calA, contact_id: cA1, assigned_user_id: null, starts_at: T(5),
      ends_at: "2026-10-05T12:30:00.000Z", status: "booked", created_at: T(2), updated_at: T(2), deleted_at: null },
    { id: id("b7", 1), workspace_id: WS_B, calendar_id: calB, contact_id: cB1, assigned_user_id: null, starts_at: T(5),
      ends_at: "2026-10-05T13:00:00.000Z", status: "booked", created_at: T(2), updated_at: T(2), deleted_at: null },
  ]);
  fake.seed("conversations", [
    { id: cvA, workspace_id: WS_A, contact_id: cA1, channel: "sms" },
    { id: cvB, workspace_id: WS_B, contact_id: cB1, channel: "email" },
  ]);
  fake.seed("messages", [
    { id: id("a8", 1), workspace_id: WS_A, conversation_id: cvA, direction: "inbound", body: "secret body A", created_at: T(4) },
    { id: id("a8", 2), workspace_id: WS_A, conversation_id: cvA, direction: "internal", body: "note A", created_at: T(3) },
    { id: id("b8", 1), workspace_id: WS_B, conversation_id: cvB, direction: "inbound", body: "bravo body", created_at: T(4) },
  ]);
  fake.seed("tasks", [
    { id: id("a9", 1), workspace_id: WS_A, title: "Call back Ada", status: "open", contact_id: cA1, opportunity_id: null,
      assigned_user_id: ownerA.id, updated_at: T(3), deleted_at: null },
    { id: id("b9", 1), workspace_id: WS_B, title: "bravo task", status: "open", contact_id: null, opportunity_id: null,
      assigned_user_id: null, updated_at: T(3), deleted_at: null },
  ]);
  fake.seed("reviews", [
    { id: id("aa", 1), workspace_id: WS_A, contact_id: cA1, rating: 5, received_at: T(4) },
    { id: id("ba", 1), workspace_id: WS_B, contact_id: null, rating: 1, received_at: T(4) },
  ]);
  fake.seed("activity_events", [
    { id: 11, workspace_id: WS_A, entity_type: "contact", entity_id: cA1, action: "created", created_at: T(6) },
    { id: 12, workspace_id: WS_B, entity_type: "contact", entity_id: cB1, action: "created", created_at: T(8) },
  ]);
}

const HANDLERS: Record<DashboardEndpoint, (req: NextRequest) => Promise<Response>> = {
  summary: getSummary, contacts: getContacts, opportunities: getOpportunities,
  appointments: getAppointments, conversations: getConversations, events: getDashboardEvents,
};

function req(path: string, init: { cookie?: string; method?: string; body?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: init.method ?? "GET", headers, body: init.body });
}

let fake: FakeSupabase;
let restoreEnv: () => void;
const cookieFor = (u: FakeUser, opts: { expired?: boolean } = {}) => fake.cookie(fake.issue(u, opts));

async function call(endpoint: DashboardEndpoint, u: FakeUser) {
  const res = await HANDLERS[endpoint](req(`/api/dashboard/${endpoint}`, { cookie: cookieFor(u) }));
  return { res, text: await res.text() };
}

beforeEach(async () => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  restoreEnv = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  fake = await startFakeSupabase();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_PROVIDER = "supabase";
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_ANON_KEY = fake.anonKey;
  fake.contexts.set(ownerA.id, memberCtx(ownerA, ws(WS_A, "Alpha"), "owner", OWNER_PERMS));
  fake.contexts.set(ownerB.id, memberCtx(ownerB, ws(WS_B, "Bravo"), "owner", OWNER_PERMS));
  fake.contexts.set(limited.id, memberCtx(limited, ws(WS_A, "Alpha"), "employee",
    READS.filter((p) => p !== "contacts.read")));
  fake.contexts.set(empty.id, memberCtx(empty, ws(WS_C, "Charlie Empty"), "owner", OWNER_PERMS));
  fake.contexts.set(outsider.id, memberCtx(outsider, null, null, []));
  seed(fake);
});

afterEach(async () => {
  restoreEnv();
  await fake.close();
});

describe("P3 adapters map native rows to the pre-migration record shapes", () => {
  const names = new Map([[ownerA.id, "Owner A"]]);

  test("contacts, opportunities, appointments", () => {
    const c = contactRecord({ id: "c", first_name: "Ada", last_name: "", email: null, phone: "1", source: "web",
      owner_user_id: ownerA.id, created_at: T(1), updated_at: T(2), contact_tags: [{ tag: "vip" }] }, names);
    assert.deepEqual(c, { externalContactId: "c", firstName: "Ada", lastName: undefined, displayName: "Ada",
      email: undefined, phone: "1", source: "web", tags: ["vip"], assignedUser: "Owner A", createdAt: T(1), updatedAt: T(2) });
    const stages = new Map([["s", { id: "s", pipeline_id: "p", name: "Qualified", position: 4, kind: "open" }]]);
    const o = opportunityRecord({ id: "o", contact_id: "c", pipeline_id: "p", stage_id: "s", status: "open",
      value_cents: "123456", assigned_user_id: null, created_at: T(1), updated_at: T(2) }, stages, names);
    assert.equal(o.monetaryValue, 1234.56, "bigint cents arrive as strings and become dollars");
    assert.deepEqual([o.stageName, o.status, o.assignedUser], ["Qualified", "open", undefined]);
    const calendars = new Map([["k", { id: "k", name: "Intro", timezone: "UTC", duration_minutes: 15, is_primary: false }]]);
    const a = appointmentRecord({ id: "a", calendar_id: "k", contact_id: "c", assigned_user_id: ownerA.id,
      starts_at: T(3), ends_at: T(4), status: "no_show", created_at: T(1), updated_at: T(2) }, calendars, names);
    assert.deepEqual([a.calendarName, a.timezone, a.start, a.status, a.assignedUser], ["Intro", "UTC", T(3), "no_show", "Owner A"]);
  });

  test("conversations never carry message bodies; internal notes have direction unknown", () => {
    const conversations = new Map([["v", { id: "v", contact_id: "c", channel: "sms" }]]);
    const inbound = conversationEventRecord({ id: "m", conversation_id: "v", direction: "inbound", created_at: T(1) }, conversations);
    assert.deepEqual(inbound, { id: "m", contactId: "c", direction: "inbound", channel: "sms",
      eventType: "conversation.inbound", timestamp: T(1), summary: "Inbound message" });
    const note = conversationEventRecord({ id: "n", conversation_id: "v", direction: "internal", created_at: T(1) }, conversations);
    assert.deepEqual([note.direction, note.eventType, note.summary], ["unknown", "conversation.internal", "Internal note"]);
  });

  test("tasks, reviews, activity, timestamps", () => {
    const t = taskEventRecord({ id: "t", title: "Call", status: "done", contact_id: null, opportunity_id: "o",
      assigned_user_id: ownerA.id, updated_at: T(2) }, names);
    assert.deepEqual(t, { id: "t", contactId: undefined, opportunityId: "o", type: "Call", status: "done",
      assignedUser: "Owner A", timestamp: T(2) });
    assert.deepEqual(reviewEventRecord({ id: "r", contact_id: null, rating: 4, received_at: T(1) }),
      { id: "r", contactId: undefined, kind: "feedback-received", resultStatus: "4/5", timestamp: T(1) });
    const e = auditEventRecord({ id: 7, entity_type: "opportunity", entity_id: "o", action: "won", created_at: T(3) }, WS_A);
    assert.deepEqual([e.id, e.eventType, e.locationId, e.entityRefs.opportunityId, e.sourceEventName],
      ["7", "opportunity.won", WS_A, "o", "opportunity.won"]);
    assert.equal(activityEventType("integration", "connected"), "system.workflow_event");
    assert.equal(latestTimestamp([undefined, T(2), "not a date", T(5), null]), T(5));
    assert.equal(latestTimestamp([]), undefined);
  });
});

describe("API-1 and isolation: /api/dashboard/* read the active workspace's native tables", () => {
  test("every endpoint answers with the pre-migration shape, from workspace A only", async () => {
    for (const endpoint of DASHBOARD_ENDPOINTS) {
      const { res, text } = await call(endpoint, ownerA);
      assert.equal(res.status, 200, `${endpoint}: ${text}`);
      const body = JSON.parse(text);
      assert.deepEqual(dashboardShapeErrors(endpoint, body), [], endpoint);
      assert.deepEqual([body.source, body.storageMode], ["workspace", "postgres"], endpoint);
      assert.equal(res.headers.get("cache-control"), "private, no-store", endpoint);
      assert.equal(/bravo|b0b0/i.test(text), false, `${endpoint} leaked workspace B: ${text}`);
      assert.equal(text.includes("secret body A"), false, `${endpoint} exposed a message body`);
    }
  });

  test("records are mapped, deleted rows are excluded, and the summary matches the records", async () => {
    const contacts = JSON.parse((await call("contacts", ownerA)).text);
    assert.deepEqual(contacts.contacts, [{ id: cA1, displayName: "Ada Lovelace", email: "[redacted]", phone: "[redacted]",
      hasEmail: true, hasPhone: true, source: "website", tags: ["vip"], assignedUser: "Owner A", updatedAt: T(2) }]);
    assert.equal(contacts.waitingForSync, false);

    const opps = JSON.parse((await call("opportunities", ownerA)).text).opportunities;
    assert.deepEqual(opps.map((o: { stageName: string; status: string; monetaryValue: number }) => [o.stageName, o.status, o.monetaryValue]),
      [["New Lead", "open", 1250.5], ["Won", "won", 500]]);

    const appts = JSON.parse((await call("appointments", ownerA)).text).appointments;
    assert.deepEqual(appts.map((a: { calendarName: string; timezone: string }) => [a.calendarName, a.timezone]),
      [["Discovery Call", "America/Chicago"]]);

    const convos = JSON.parse((await call("conversations", ownerA)).text).conversations;
    assert.deepEqual(convos.map((c: { direction: string; channel: string; contactId: string }) => [c.direction, c.channel, c.contactId]),
      [["inbound", "sms", cA1], ["unknown", "sms", cA1]]);

    const events = JSON.parse((await call("events", ownerA)).text).events;
    assert.deepEqual(events.map((e: { eventType: string; locationId: string; note: string }) => [e.eventType, e.locationId, e.note]),
      [["lead.created", WS_A, "—"]]);

    const { summary } = JSON.parse((await call("summary", ownerA)).text);
    assert.deepEqual(summary, { contactsCount: 1, opportunitiesCount: 2, appointmentsCount: 1, conversationEventsCount: 2,
      openPipelineValue: 1250.5, wonCount: 1, lastEventAt: T(6), waitingForSync: false });
  });

  test("workspace B's owner sees only workspace B", async () => {
    const { summary } = JSON.parse((await call("summary", ownerB)).text);
    assert.deepEqual([summary.contactsCount, summary.opportunitiesCount, summary.openPipelineValue], [1, 1, 7777]);
    const { text } = await call("contacts", ownerB);
    assert.deepEqual(JSON.parse(text).contacts.map((c: { id: string }) => c.id), [cB1]);
    assert.equal(/Ada|a0a0|Alpha/.test(text), false, text);
  });

  test("every table read uses the caller's own JWT and the context's workspace; none uses the service role", async () => {
    for (const endpoint of DASHBOARD_ENDPOINTS) await call(endpoint, ownerA);
    const reads = fake.tableCalls();
    assert.ok(reads.length > 20, `expected native reads, saw ${reads.length}`);
    for (const r of reads) {
      assert.notEqual(r.bearer, fake.serviceKey, `service role used for ${r.path}`);
      assert.notEqual(r.bearer, fake.anonKey, `anon key used for ${r.path}`);
      if (!r.path.startsWith("/rest/v1/profiles")) {
        assert.ok(r.path.includes(`workspace_id=eq.${WS_A}`), `unscoped read ${r.path}`);
      }
    }
  });

  test("the open pipeline value pages past the API's row cap", async () => {
    fake.limits.maxRows = 2;
    fake.seed("opportunities", [1, 2, 3, 4, 5].map((n) => ({
      id: id("ac", n), workspace_id: WS_A, contact_id: cA1, pipeline_id: pA, stage_id: sA1, status: "open",
      value_cents: 1000 * n, assigned_user_id: null, created_at: T(1), updated_at: T(1), deleted_at: null,
    })));
    const { summary } = JSON.parse((await call("summary", ownerA)).text);
    assert.equal(summary.openPipelineValue, 1250.5 + 150, "125050 + 1000·(1+…+5) cents");
    assert.equal(summary.opportunitiesCount, 7, "counts are exact, not capped");
  });

  test("an empty workspace reports waiting with empty lists", async () => {
    for (const endpoint of DASHBOARD_ENDPOINTS) {
      const { res, text } = await call(endpoint, empty);
      assert.equal(res.status, 200, text);
      const body = JSON.parse(text);
      assert.deepEqual(dashboardShapeErrors(endpoint, body), [], endpoint);
      if (endpoint === "summary") {
        assert.deepEqual(body.summary, { contactsCount: 0, opportunitiesCount: 0, appointmentsCount: 0,
          conversationEventsCount: 0, openPipelineValue: 0, wonCount: 0, waitingForSync: true });
      } else {
        assert.deepEqual([body[endpoint], body.waitingForSync], [[], true], endpoint);
      }
    }
  });
});

describe("P3 permissions, failures, and refreshed sessions", () => {
  test("signed-out callers get 401; callers without a workspace get 403 no_active_workspace", async () => {
    for (const endpoint of DASHBOARD_ENDPOINTS) {
      const anon = await HANDLERS[endpoint](req(`/api/dashboard/${endpoint}`));
      assert.deepEqual([anon.status, (await anon.json()).code], [401, "unauthenticated"], endpoint);
      const { res, text } = await call(endpoint, outsider);
      assert.deepEqual([res.status, JSON.parse(text).code], [403, "no_active_workspace"], endpoint);
    }
    assert.equal(fake.tableCalls().length, 0, "no data is read for refused callers");
  });

  test("each endpoint requires its §7.3 permission", async () => {
    const contacts = await call("contacts", limited);
    assert.deepEqual([contacts.res.status, JSON.parse(contacts.text).code], [403, "forbidden"]);
    for (const endpoint of ["summary", "opportunities", "appointments", "conversations", "events"] as const) {
      assert.equal((await call(endpoint, limited)).res.status, 200, endpoint);
    }
    const required: Record<DashboardEndpoint, string> = {
      summary: "dashboard.read", contacts: "contacts.read", opportunities: "pipeline.read",
      appointments: "calendar.read", conversations: "conversations.read", events: "dashboard.read",
    };
    for (const [endpoint, permission] of Object.entries(required) as [DashboardEndpoint, string][]) {
      fake.contexts.set(limited.id, memberCtx(limited, ws(WS_A, "Alpha"), "employee", READS.filter((p) => p !== permission)));
      const { res, text } = await call(endpoint, limited);
      assert.deepEqual([res.status, JSON.parse(text).code], [403, "forbidden"], `${endpoint} without ${permission}`);
    }
  });

  test("a database failure answers 503 unavailable and still delivers a refreshed session", async () => {
    fake.faults.tableFails = "*";
    for (const endpoint of DASHBOARD_ENDPOINTS) {
      const res = await HANDLERS[endpoint](req(`/api/dashboard/${endpoint}`, { cookie: cookieFor(ownerA, { expired: true }) }));
      assert.deepEqual([res.status, (await res.json()).code], [503, "unavailable"], endpoint);
      assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("sb-127-auth-token")), `${endpoint}: refreshed cookie`);
    }
    fake.faults.tableFails = "profiles";
    assert.equal((await call("contacts", ownerA)).res.status, 503, "a failed name lookup is not silently dropped");
  });

  test("an expired access token with a valid refresh token reads data and returns the new cookie", async () => {
    const res = await getSummary(req("/api/dashboard/summary", { cookie: cookieFor(ownerA, { expired: true }) }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).summary.contactsCount, 1);
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("sb-127-auth-token")));
  });
});

describe("P3 tenant configuration, public branding, and health", () => {
  test("/api/tenant/config returns the workspace's settings; settings.write holders get { pipelineName, stagesCount }", async () => {
    const res = await getTenantConfig(req("/api/tenant/config", { cookie: cookieFor(ownerA) }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      client: { businessName: "Alpha Plumbing", legalBusinessName: "Alpha Plumbing LLC", timezone: "America/Chicago",
        industry: "Plumbing", supportEmail: "help@alpha.example.invalid", phone: "555-0100",
        website: "https://alpha.example.invalid", bookingUrl: "https://alpha.example.invalid/book",
        reviewUrl: "https://alpha.example.invalid/review" },
      owner: { pipelineName: "Sales Pipeline A", stagesCount: 2 },
    });
    const employee = await (await getTenantConfig(req("/api/tenant/config", { cookie: cookieFor(limited) }))).json();
    assert.equal(employee.owner, undefined, "no owner block without settings.write");
    assert.equal(employee.client.businessName, "Alpha Plumbing");
  });

  test("/api/tenant/config requires settings.read and falls back to the workspace name without a settings row", async () => {
    fake.contexts.set(limited.id, memberCtx(limited, ws(WS_A, "Alpha"), "employee", ["dashboard.read"]));
    const denied = await getTenantConfig(req("/api/tenant/config", { cookie: cookieFor(limited) }));
    assert.deepEqual([denied.status, (await denied.json()).code], [403, "forbidden"]);
    const res = await getTenantConfig(req("/api/tenant/config", { cookie: cookieFor(empty) }));
    const body = await res.json();
    assert.deepEqual([body.client.businessName, body.client.legalBusinessName, body.owner],
      ["Charlie Empty", "Charlie Empty", { pipelineName: "Sales Pipeline", stagesCount: 0 }]);
  });

  test("/api/tenant/public serves platform branding only", async () => {
    const body = await (await getTenantPublic()).json();
    assert.equal(body.client.businessName, body.platform.brandName);
    assert.deepEqual([body.client.logoUrl, body.client.hasLogo], ["", false]);
    assert.equal(JSON.stringify(body).includes("Alpha"), false);
    assert.equal(fake.calls.length, 0, "public branding reads no workspace data");
  });

  test("/api/health reports { ok, db, authProvider } from the local database API only", async () => {
    const ok = await (await getHealth(req("/api/health"))).json();
    assert.deepEqual([ok.ok, ok.db, ok.authProvider], [true, "ok", "supabase"]);
    assert.ok(fake.calls.every((c) => c.bearer === null), "probed with the anon key only, no session");
    assert.equal(JSON.stringify(ok).includes("ghl"), false);
    process.env.SUPABASE_URL = "http://127.0.0.1:9";
    const down = await getHealth(req("/api/health"));
    assert.equal(down.status, 200);
    const body = await down.json();
    assert.deepEqual([body.ok, body.db], [false, "error"]);
  });

  test("deployment-wide legacy endpoints answer 404 not_available after authentication", async () => {
    const owner = cookieFor(ownerA);
    for (const [label, handler] of [["events", getEvents], ["sync/health", getSyncHealth], ["onboarding/readiness", getReadiness]] as const) {
      const anon = await handler(req(`/api/${label}`));
      assert.equal(anon.status, 401, `${label} signed out`);
      const res = await handler(req(`/api/${label}`, { cookie: owner }));
      assert.deepEqual([res.status, (await res.json()).code], [404, "not_available"], label);
    }
    const ghl = await getGhlHealth(req("/api/ghl/health"));
    assert.deepEqual([ghl.status, (await ghl.json()).code], [404, "not_available"]);
    const lead = await postLead(req("/api/leads", { method: "POST", body: "{}" }));
    assert.deepEqual([lead.status, (await lead.json()).code], [404, "not_available"]);
  });
});

describe("P3 legacy mode is unchanged", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "legacy";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  test("/api/dashboard/* still read the sync store, with the same shapes as native mode", async () => {
    const store = resetSyncStoreForTests();
    await store.upsertContact({ externalContactId: "ghl-c1", firstName: "Legacy", tags: ["x"], phone: "1", updatedAt: T(1) });
    await store.upsertOpportunity({ externalOpportunityId: "ghl-o1", stageName: "Qualified", monetaryValue: 10, updatedAt: T(1) });
    await store.upsertAppointment({ externalAppointmentId: "ghl-a1", status: "booked", updatedAt: T(1) });
    await store.appendConversationEvent({ id: "ghl-m1", eventType: "conversation.inbound", timestamp: T(1) });
    try {
      for (const endpoint of DASHBOARD_ENDPOINTS) {
        const res = await HANDLERS[endpoint](req(`/api/dashboard/${endpoint}`));
        assert.equal(res.status, 200, endpoint);
        const body = await res.json();
        assert.deepEqual(dashboardShapeErrors(endpoint, body), [], endpoint);
        assert.deepEqual([body.source, body.storageMode], ["sync-store", "memory"], endpoint);
      }
      const contacts = await (await getContacts(req("/api/dashboard/contacts"))).json();
      assert.deepEqual(contacts.contacts[0], { id: "ghl-c1", displayName: "Legacy", phone: "[redacted]", hasEmail: false,
        hasPhone: true, source: "—", tags: ["x"], assignedUser: "—", updatedAt: T(1) });
      assert.equal(fake.calls.length, 0, "legacy mode never contacts Supabase");
    } finally {
      resetSyncStoreForTests();
    }
  });

  test("legacy tenant config, public branding, and legacy endpoints keep their behaviour", async () => {
    const config = await (await getTenantConfig(req("/api/tenant/config"))).json();
    assert.deepEqual(Object.keys(config.client).sort(), ["bookingUrl", "businessName", "industry", "legalBusinessName",
      "phone", "reviewUrl", "supportEmail", "timezone", "website"]);
    const pub = await (await getTenantPublic()).json();
    assert.ok(pub.client.businessName);
    assert.equal((await getSyncHealth(req("/api/sync/health"))).status, 200);
    assert.equal((await getEvents(req("/api/events"))).status, 200);
  });
});

describe("P3 static checks", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((f) => {
      const rel = `${dir}/${f}`;
      return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : [rel];
    });

  test("the data layer has no process-wide caches, no service role, and no workspace argument", () => {
    const data = files("src/lib/data");
    assert.ok(data.length >= 15, data.join(", "));
    for (const f of data) {
      const src = read(f);
      assert.equal(/globalThis/.test(src), false, `${f} uses globalThis`);
      assert.equal(/service_role|SERVICE_ROLE|supabase\/admin|serviceKey/.test(src), false, `${f} references the service role`);
      assert.equal(/workspaceId|workspace_id\s*:/.test(src), false, `${f} takes or writes a workspace id`);
    }
  });

  test("pages and dashboard APIs read through src/lib/data, not the sync store or deployment config", () => {
    const pages = ["dashboard/page.tsx", "contacts/page.tsx", "pipeline/page.tsx", "calendar/page.tsx", "tasks/page.tsx",
      "reviews/page.tsx", "reporting/page.tsx", "help/page.tsx", "library/page.tsx", "onboarding/page.tsx"];
    for (const p of pages) {
      const src = read(`src/app/(protected)/${p}`);
      assert.ok(src.includes("getPageData"), `${p} does not use getPageData`);
      assert.equal(/getSyncStore|@\/lib\/tenant-ui|clientBusinessName|clientReviewUrl|clientSupportEmail|clientBookingUrl/.test(src),
        false, `${p} reads deployment data directly`);
    }
    for (const e of DASHBOARD_ENDPOINTS) {
      const src = read(`src/app/api/dashboard/${e}/route.ts`);
      assert.ok(src.includes("readApi"), e);
      assert.equal(src.includes("getSyncStore"), false, e);
    }
  });

  test("native copy has no sync, CRM, or vendor language; legacy copy is unchanged", () => {
    const texts = [NATIVE_COPY.sourceShort, NATIVE_COPY.sourceDetail, NATIVE_COPY.bannerActive,
      ...["contacts", "task events", "review events", "conversation events", "leads", "metrics", "report data", "appointments"]
        .flatMap((e) => [NATIVE_COPY.bannerWaiting(e), NATIVE_COPY.waitingTitle(e), NATIVE_COPY.waitingNote(e)])];
    for (const t of texts) {
      assert.equal(/sync|crm|workflow/i.test(t), false, t);
      for (const term of CLIENT_FORBIDDEN_RENDER_TERMS) assert.equal(t.includes(term), false, `${t} contains ${term}`);
    }
    assert.equal(NATIVE_COPY.waitingTitle("contacts"), "No contacts yet");
    assert.equal(NATIVE_COPY.bannerWaiting("task events"), "No tasks yet.");
    assert.equal(NATIVE_COPY.waitingNote("activity"), "Activity added to this workspace appears here. Nothing is invented here.");
    assert.equal(NATIVE_COPY.waitingNote("leads"), "Contacts added to this workspace appear here. Nothing is invented here.");
    const onboarding = readFileSync(join(ROOT, "src", "app", "(protected)", "onboarding", "page.tsx"), "utf8");
    assert.match(onboarding, /native\s*\?\s*"Owner-only setup status for this workspace\./, "native onboarding description");
    const settings = readFileSync(join(ROOT, "src", "app", "(protected)", "settings", "page.tsx"), "utf8");
    assert.match(settings, /me\?\.legacyRole/, "settings reads the native membership's legacy role");
    assert.match(settings, /isNative \? "\/api\/dashboard\/summary" : "\/api\/sync\/health"/, "native settings never calls the sync endpoint");
    assert.match(settings, /No integrations are connected to this workspace yet\./);
    assert.equal(SYNC_COPY.waitingTitle("contacts"), "Waiting for sync");
    assert.equal(SYNC_COPY.bannerWaiting("contacts"), "Waiting for sync — no contacts yet.");
  });
});

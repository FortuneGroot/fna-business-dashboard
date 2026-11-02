// P5 native records (spec §7.4): strict validation, keyset cursors, search sanitising, money/time
// helpers, and route behaviour against the local fake Supabase (tests/helpers/fake-supabase.ts;
// nothing leaves 127.0.0.1). Database enforcement (RLS, grants, RPCs, overlap constraint) and the
// full CRUD flows run against PGlite (tests/db/p5-crm.test.ts) and the real local Supabase stack.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { ApiError, encodeCursor } from "../src/lib/api/native";
import { afterKeyset, decodeKeyset, nextKeyset, searchWords } from "../src/lib/native/records";
import { contactCreate, contactListQuery, contactPatch, noteInput } from "../src/lib/native/contacts";
import { moveInput, opportunityCreate, opportunityListQuery, opportunityPatch, stagePatch } from "../src/lib/native/opportunities";
import { appointmentCreate, appointmentListQuery, appointmentPatch, availabilityInput, calendarCreate, calendarPatch } from "../src/lib/native/calendars";
import { taskCreate, taskListQuery, taskPatch } from "../src/lib/native/tasks";
import { conversationListQuery, conversationNote } from "../src/lib/native/conversations";
import { reportQuery } from "../src/lib/native/reports";
import { dollars, fromLocalInput, toCents, toLocalInput, when } from "../src/lib/ui/native-api";
import { GET as listContactsRoute, POST as createContactRoute } from "../src/app/api/contacts/route";
import { DELETE as deleteContactRoute, GET as getContactRoute, PATCH as patchContactRoute } from "../src/app/api/contacts/[id]/route";
import { POST as contactNoteRoute } from "../src/app/api/contacts/[id]/notes/route";
import { GET as pipelineRoute } from "../src/app/api/pipeline/route";
import { PATCH as stageRoute } from "../src/app/api/pipeline/stages/[id]/route";
import { GET as listOppsRoute, POST as createOppRoute } from "../src/app/api/opportunities/route";
import { DELETE as deleteOppRoute, GET as getOppRoute, PATCH as patchOppRoute } from "../src/app/api/opportunities/[id]/route";
import { POST as moveOppRoute } from "../src/app/api/opportunities/[id]/move/route";
import { GET as listCalendarsRoute, POST as createCalendarRoute } from "../src/app/api/calendars/route";
import { PATCH as patchCalendarRoute } from "../src/app/api/calendars/[id]/route";
import { PUT as availabilityRoute } from "../src/app/api/calendars/[id]/availability/route";
import { GET as listApptsRoute, POST as createApptRoute } from "../src/app/api/appointments/route";
import { PATCH as patchApptRoute } from "../src/app/api/appointments/[id]/route";
import { GET as listTasksRoute, POST as createTaskRoute } from "../src/app/api/tasks/route";
import { PATCH as patchTaskRoute } from "../src/app/api/tasks/[id]/route";
import { GET as listConvosRoute } from "../src/app/api/conversations/route";
import { GET as messagesRoute } from "../src/app/api/conversations/[id]/messages/route";
import { POST as convoNoteRoute } from "../src/app/api/conversations/[id]/notes/route";
import { GET as reviewsRoute } from "../src/app/api/reviews/route";
import { GET as reportRoute } from "../src/app/api/reports/summary/route";

const ROOT = join(__dirname, "..");
const ENV_KEYS = [
  "AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL", "AUTH_OWNER_PASSWORD", "AUTH_ALLOW_MEMORY_SESSIONS", "VERCEL_ENV", "AUTH_FAIL_CLOSED",
];
const WS_A = "00000000-0000-4000-8000-00000000a0a0";
const WS_B = "00000000-0000-4000-8000-00000000b0b0";
const ID = "00000000-0000-4000-8000-0000000c0001";
const ID2 = "00000000-0000-4000-8000-0000000c0002";
const EMPLOYEE_PERMS = [
  "dashboard.read", "contacts.read", "contacts.write", "pipeline.read", "opportunities.write", "calendar.read",
  "appointments.write", "conversations.read", "conversations.write", "tasks.read", "tasks.write", "reviews.read",
  "reports.read", "settings.read", "team.read",
];
const READ_ONLY_PERMS = EMPLOYEE_PERMS.filter((p) => !/\.(write)$/.test(p));
const owner: FakeUser = { id: "00000000-0000-4000-8000-0000000a0001", email: "owner-a@example.invalid", name: "Owner A" };
const employee: FakeUser = { id: "00000000-0000-4000-8000-0000000a0003", email: "employee-a@example.invalid", name: "Employee A" };
const OWNER_PERMS = [...EMPLOYEE_PERMS, "contacts.delete", "opportunities.delete", "pipeline.configure", "calendar.configure"];
const ctxFor = (u: FakeUser, role: string, permissions: string[], ws = WS_A) => ({
  authenticated: true, user_id: u.id, is_platform_admin: false, workspace: { id: ws, name: "Alpha", slug: "alpha", status: "active" },
  role, grant: null, permissions,
});

// Route handlers type their own params; tests pass them as a plain record.
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;
const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });

function req(path: string, init: { cookie?: string; method?: string; body?: unknown; contentType?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (init.body !== undefined && contentType !== null) headers.set("content-type", contentType);
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, true, `should accept ${JSON.stringify(value)}`);
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, `should reject ${JSON.stringify(value)}`);

// ---------------------------------------------------------------------------
describe("P5 validation (zod, strict)", () => {
  test("contacts: a name, email, or phone is required; email/phone/tags checked; unknown keys and workspace ids refused", () => {
    ok(contactCreate, { firstName: "Ada" });
    ok(contactCreate, { email: "ADA@Example.INVALID", tags: ["vip", "VIP", "lead"] });
    assert.deepEqual(contactCreate.parse({ email: " ADA@Example.INVALID ", tags: ["vip", "VIP"] }), { email: "ada@example.invalid", tags: ["vip"] });
    for (const v of [{}, { firstName: "" }, { email: "nope" }, { phone: "call me" }, { tags: ["a,b"] }, { tags: [""] },
      { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, { firstName: "x".repeat(101) }, { firstName: "A", workspaceId: WS_B },
      { firstName: "A", workspace_id: WS_B }, { firstName: "A", deleted_at: null }, { firstName: "A", ownerUserId: "not-a-uuid" }]) {
      bad(contactCreate, v);
    }
    ok(contactPatch, { ownerUserId: null });
    bad(contactPatch, {});
    ok(contactListQuery, { q: "ada", tag: "vip", limit: "100" });
    for (const v of [{ limit: "101" }, { limit: "0" }, { q: "x".repeat(101) }, { workspace: WS_B }, { tag: "a,b" }]) bad(contactListQuery, v);
    bad(noteInput, { body: "   " });
    bad(noteInput, { body: "x".repeat(10001) });
  });

  test("opportunities: whole non-negative cents only; stage moves by id; stage rename only", () => {
    ok(opportunityCreate, { contactId: ID, stageId: ID2, title: "Roof", valueCents: 150050 });
    for (const v of [{ contactId: ID, stageId: ID2, title: "Roof", valueCents: 1.5 }, { contactId: ID, stageId: ID2, title: "Roof", valueCents: -1 },
      { contactId: ID, stageId: ID2, title: "Roof", valueCents: 1e12 + 1 }, { contactId: ID, stageId: ID2, title: "" },
      { contactId: ID, stageId: "New Lead", title: "Roof" }, { contactId: ID, stageId: ID2, title: "Roof", pipelineId: ID },
      { contactId: ID, stageId: ID2, title: "Roof", status: "won" }, { contactId: ID, stageId: ID2, title: "Roof", valueCents: "100" }]) {
      bad(opportunityCreate, v);
    }
    bad(opportunityPatch, {});
    bad(opportunityPatch, { stageId: ID2 });
    ok(moveInput, { stageId: ID2 });
    bad(moveInput, { stage: "Won" });
    ok(stagePatch, { name: "Second Look" });
    for (const v of [{ name: "" }, { name: "x", position: 1 }, { kind: "won" }]) bad(stagePatch, v);
    bad(opportunityListQuery, { status: "deleted" });
  });

  test("calendars and availability: slug, timezone, duration bounds; same-day windows cannot overlap", () => {
    ok(calendarCreate, { name: "Discovery", slug: "discovery", timezone: "America/Chicago", durationMinutes: 30, memberUserIds: [ID, ID.toUpperCase()] });
    assert.deepEqual(calendarCreate.parse({ name: "D", slug: "d", timezone: "UTC", durationMinutes: 30, memberUserIds: [ID, ID.toUpperCase()] }).memberUserIds, [ID]);
    for (const v of [{ name: "D", slug: "Has Spaces", timezone: "UTC", durationMinutes: 30 }, { name: "D", slug: "d", timezone: "Mars/Base", durationMinutes: 30 },
      { name: "D", slug: "d", timezone: "UTC", durationMinutes: 4 }, { name: "D", slug: "d", timezone: "UTC", durationMinutes: 481 },
      { name: "D", slug: "d", timezone: "UTC", durationMinutes: 30, isPrimary: true }, { name: "D", slug: "d", timezone: "UTC", durationMinutes: 30, memberUserIds: ["x"] }]) {
      bad(calendarCreate, v);
    }
    bad(calendarPatch, {});
    ok(availabilityInput, { rules: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "13:00", end: "17:00" }] });
    ok(availabilityInput, { rules: [] });
    for (const rules of [[{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "11:00", end: "13:00" }],
      [{ weekday: 7, start: "09:00", end: "10:00" }], [{ weekday: 1, start: "17:00", end: "09:00" }], [{ weekday: 1, start: "9:00", end: "10:00" }],
      [{ weekday: 1, start: "24:00", end: "24:30" }]]) {
      bad(availabilityInput, { rules });
    }
  });

  test("appointments: offset timestamps, end after start, at most 24 hours; list range bounded", () => {
    const base = { calendarId: ID, contactId: ID2, startsAt: "2031-05-06T14:00:00Z", endsAt: "2031-05-06T14:30:00Z" };
    ok(appointmentCreate, base);
    ok(appointmentCreate, { ...base, startsAt: "2031-05-06T09:00:00-05:00", endsAt: "2031-05-06T09:30:00-05:00" });
    for (const v of [{ ...base, endsAt: base.startsAt }, { ...base, endsAt: "2031-05-07T14:30:00Z" }, { ...base, startsAt: "2031-05-06 14:00" },
      { ...base, startsAt: "2031-05-06T14:00:00" }, { ...base, status: "booked" }, { ...base, workspaceId: WS_B }]) {
      bad(appointmentCreate, v);
    }
    ok(appointmentPatch, { status: "cancelled" });
    bad(appointmentPatch, { status: "deleted" });
    bad(appointmentPatch, { startsAt: "2031-05-06T15:00:00Z", endsAt: "2031-05-06T14:00:00Z" });
    bad(appointmentPatch, { calendarId: ID });
    bad(appointmentListQuery, { from: "2031-01-01T00:00:00Z", to: "2032-03-01T00:00:00Z" });
    bad(appointmentListQuery, { limit: "501" });
  });

  test("tasks, conversation notes, and report ranges", () => {
    ok(taskCreate, { title: "Call back", assignedUserId: ID, dueAt: null });
    for (const v of [{ title: "" }, { title: "x", status: "archived" }, { title: "x", dueAt: "tomorrow" }, { title: "x", assignedUserId: "me" }]) bad(taskCreate, v);
    bad(taskPatch, {});
    bad(taskListQuery, { status: "late" });
    ok(conversationNote, { body: "Called, left voicemail" });
    bad(conversationNote, { body: "hi", direction: "outbound" });
    bad(conversationListQuery, { channel: "sms" });
    bad(reportQuery, { from: "2031-01-02T00:00:00Z", to: "2031-01-01T00:00:00Z" });
    bad(reportQuery, { from: "2030-01-01T00:00:00Z", to: "2031-03-01T00:00:00Z" });
    bad(reportQuery, { from: "2999-01-01T00:00:00Z" });
    bad(reportQuery, { from: "2000-01-01T00:00:00Z" });
    assert.ok(reportQuery.safeParse({ from: new Date(Date.now() - 7 * 86_400_000).toISOString() }).success, "a recent `from` alone is fine");
  });
});

describe("P5 keyset cursors and search", () => {
  test("cursors carry a validated timestamp and id only; tampered cursors are 422", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, t: `2031-01-0${n}T00:00:00.123456+00:00` }));
    const cursor = nextKeyset(rows, 2, (r) => r.t);
    assert.ok(cursor);
    assert.deepEqual(decodeKeyset(cursor!), { t: rows[1].t, id: rows[1].id });
    assert.equal(nextKeyset(rows, 3, (r) => r.t), null, "no cursor on the last page");
    assert.equal(decodeKeyset(undefined), null);
    for (const tampered of [encodeCursor({ t: "2031-01-01T00:00:00Z),id.gt.0", id: rows[0].id }), encodeCursor({ t: rows[0].t, id: "x" }),
      encodeCursor({ t: rows[0].t, id: rows[0].id, extra: 1 }), "not-base64!", encodeCursor({ id: 5 })]) {
      assert.throws(() => decodeKeyset(tampered), (e: unknown) => e instanceof ApiError && e.status === 422, tampered);
    }
    assert.equal(afterKeyset("created_at", { t: rows[0].t, id: rows[0].id.toUpperCase() }),
      `created_at.lt.${rows[0].t},and(created_at.eq.${rows[0].t},id.lt.${rows[0].id})`);
  });

  test("search words cannot carry PostgREST syntax and are capped at five", () => {
    assert.deepEqual(searchWords("Ada Lovelace"), ["Ada", "Lovelace"]);
    assert.deepEqual(searchWords("ada@example.invalid +1 (555) 010"), ["ada@example.invalid", "+1", "555", "010"]);
    assert.deepEqual(searchWords("a,b)or(id.gt.0*"), ["a", "b", "or", "id.gt.0"]);
    assert.deepEqual(searchWords(`x" ; drop % \\ ,`), ["x", "drop"]);
    assert.deepEqual(searchWords("jo_n"), ["jo", "n"], "an underscore is an ilike wildcard, so it separates words");
    assert.deepEqual(searchWords("one two three four five six"), ["one", "two", "three", "four", "five"]);
    assert.deepEqual(searchWords("   "), []);
    assert.deepEqual(searchWords(undefined), []);
    for (const w of searchWords("é,ü(ß)*\"'")) assert.equal(/[,()*"\\%]/.test(w), false, w);
  });

  test("money and time helpers: integer cents, never floating point; UTC display identical on server and client", () => {
    assert.equal(toCents("12.3"), 1230);
    assert.equal(toCents("$1,500.05"), 150005);
    assert.equal(toCents("0.29"), 29);
    assert.equal(toCents("19.99"), 1999);
    for (const v of ["-1", "1.234", "abc", "", "1e3", "12345678901"]) assert.equal(toCents(v), null, v);
    assert.equal(dollars(150005), "$1,500.05");
    assert.equal(dollars(20050), "$200.50");
    assert.equal(dollars(0), "$0");
    assert.equal(when("2031-05-06T14:00:00.000Z"), "2031-05-06 14:00");
    assert.equal(when("2031-05-06T09:00:00-05:00"), "2031-05-06 14:00");
    assert.equal(when(null), "—");
    assert.equal(when("garbage"), "—");
    const local = toLocalInput("2031-05-06T14:00:00Z");
    assert.equal(fromLocalInput(local), "2031-05-06T14:00:00.000Z", "local input round-trips");
    assert.equal(fromLocalInput(""), null);
  });
});

// ---------------------------------------------------------------------------
const ROUTES: [string, string, Handler, Record<string, string>, unknown?][] = [
  ["GET", "/api/contacts", listContactsRoute as Handler, {}],
  ["POST", "/api/contacts", createContactRoute as Handler, {}, { firstName: "X" }],
  ["GET", `/api/contacts/${ID}`, getContactRoute as Handler, { id: ID }],
  ["PATCH", `/api/contacts/${ID}`, patchContactRoute as Handler, { id: ID }, { firstName: "X" }],
  ["DELETE", `/api/contacts/${ID}`, deleteContactRoute as Handler, { id: ID }],
  ["POST", `/api/contacts/${ID}/notes`, contactNoteRoute as Handler, { id: ID }, { body: "n" }],
  ["GET", "/api/pipeline", pipelineRoute as Handler, {}],
  ["PATCH", `/api/pipeline/stages/${ID}`, stageRoute as Handler, { id: ID }, { name: "N" }],
  ["GET", "/api/opportunities", listOppsRoute as Handler, {}],
  ["POST", "/api/opportunities", createOppRoute as Handler, {}, { contactId: ID, stageId: ID2, title: "T" }],
  ["GET", `/api/opportunities/${ID}`, getOppRoute as Handler, { id: ID }],
  ["PATCH", `/api/opportunities/${ID}`, patchOppRoute as Handler, { id: ID }, { title: "T" }],
  ["DELETE", `/api/opportunities/${ID}`, deleteOppRoute as Handler, { id: ID }],
  ["POST", `/api/opportunities/${ID}/move`, moveOppRoute as Handler, { id: ID }, { stageId: ID2 }],
  ["GET", "/api/calendars", listCalendarsRoute as Handler, {}],
  ["POST", "/api/calendars", createCalendarRoute as Handler, {}, { name: "C", slug: "c", timezone: "UTC", durationMinutes: 30 }],
  ["PATCH", `/api/calendars/${ID}`, patchCalendarRoute as Handler, { id: ID }, { name: "C" }],
  ["PUT", `/api/calendars/${ID}/availability`, availabilityRoute as Handler, { id: ID }, { rules: [] }],
  ["GET", "/api/appointments", listApptsRoute as Handler, {}],
  ["POST", "/api/appointments", createApptRoute as Handler, {}, { calendarId: ID, contactId: ID2, startsAt: "2031-05-06T14:00:00Z", endsAt: "2031-05-06T14:30:00Z" }],
  ["PATCH", `/api/appointments/${ID}`, patchApptRoute as Handler, { id: ID }, { status: "confirmed" }],
  ["GET", "/api/tasks", listTasksRoute as Handler, {}],
  ["POST", "/api/tasks", createTaskRoute as Handler, {}, { title: "T" }],
  ["PATCH", `/api/tasks/${ID}`, patchTaskRoute as Handler, { id: ID }, { status: "done" }],
  ["GET", "/api/conversations", listConvosRoute as Handler, {}],
  ["GET", `/api/conversations/${ID}/messages`, messagesRoute as Handler, { id: ID }],
  ["POST", `/api/conversations/${ID}/notes`, convoNoteRoute as Handler, { id: ID }, { body: "n" }],
  ["GET", "/api/reviews", reviewsRoute as Handler, {}],
  ["GET", "/api/reports/summary", reportRoute as Handler, {}],
];

const call = (route: (typeof ROUTES)[number], cookie?: string, override?: { path?: string; body?: unknown; headers?: Record<string, string> }) => {
  const [method, path, handler, p, body] = route;
  return handler(req(override?.path ?? path, { method, cookie, body: override && "body" in override ? override.body : body, headers: override?.headers }), params(p));
};

describe("P5 routes (AUTH_PROVIDER=supabase, fake Supabase)", () => {
  let fake: FakeSupabase;
  let restoreEnv: () => void;
  const cookie = (u: FakeUser) => fake.cookie(fake.issue(u));

  beforeEach(async () => {
    const prev: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prev[k] = process.env[k];
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
    fake.contexts.set(owner.id, ctxFor(owner, "owner", OWNER_PERMS));
    fake.contexts.set(employee.id, ctxFor(employee, "employee", EMPLOYEE_PERMS));
    const contact = (id: string, ws: string, first: string, created: string, deleted: string | null = null) => ({
      id, workspace_id: ws, first_name: first, last_name: "Native", email: null, phone: null, source: "manual",
      owner_user_id: null, dnd: false, created_at: created, updated_at: created, deleted_at: deleted,
    });
    fake.seed("contacts", [
      contact("00000000-0000-4000-8000-00000000c0a1", WS_A, "Ada", "2031-01-01T00:00:00+00:00"),
      contact("00000000-0000-4000-8000-00000000c0a2", WS_A, "Grace", "2031-01-02T00:00:00+00:00"),
      contact("00000000-0000-4000-8000-00000000c0a3", WS_A, "Edsger", "2031-01-03T00:00:00+00:00"),
      contact("00000000-0000-4000-8000-00000000c0a4", WS_A, "Deleted", "2031-01-04T00:00:00+00:00", "2031-02-01T00:00:00+00:00"),
      contact("00000000-0000-4000-8000-00000000c0b1", WS_B, "Bravo", "2031-01-05T00:00:00+00:00"),
    ]);
  });

  afterEach(async () => {
    await fake.close();
    restoreEnv();
  });

  test("all 29 P5 handlers refuse a request without a session (401 unauthenticated)", async () => {
    assert.equal(ROUTES.length, 29);
    for (const route of ROUTES) {
      const r = await json(await call(route));
      assert.deepEqual([r.status, r.body.code], [401, "unauthenticated"], `${route[0]} ${route[1]}`);
    }
  });

  test("an employee is refused delete and configure operations before the database is touched (403)", async () => {
    const c = cookie(employee);
    const denied = ROUTES.filter(([method, path]) =>
      (method === "DELETE") || path.startsWith("/api/pipeline/stages") || (path.startsWith("/api/calendars") && method !== "GET"));
    assert.equal(denied.length, 6);
    for (const route of denied) {
      const r = await json(await call(route, c));
      assert.deepEqual([r.status, r.body.code], [403, "forbidden"], `${route[0]} ${route[1]}`);
    }
    for (const name of ["soft_delete_contact", "soft_delete_opportunity", "save_calendar", "replace_availability"]) {
      assert.equal(fake.rpcCalls(name).length, 0, `${name} must not be called`);
    }
    assert.equal(fake.calls.some((x) => x.method !== "GET" && x.method !== "HEAD" && !x.path.startsWith("/rest/v1/rpc/request_context")), false);
  });

  test("a tab pinned to another workspace is refused on every route (409 workspace_changed) before any write", async () => {
    const c = cookie(owner);
    for (const route of ROUTES) {
      const r = await json(await call(route, c, { headers: { "x-fna-workspace": WS_B } }));
      assert.deepEqual([r.status, r.body.code], [409, "workspace_changed"], `${route[0]} ${route[1]}`);
    }
    assert.equal(fake.calls.some((x) => x.method !== "GET" && x.method !== "HEAD" && !x.path.startsWith("/rest/v1/rpc/request_context")), false,
      "no write reached the database");
    for (const pin of [WS_A, WS_A.toUpperCase(), ""]) {
      const r = await json(await call(ROUTES.find((x) => x[0] === "GET" && x[1] === "/api/contacts")!, c, { headers: pin ? { "x-fna-workspace": pin } : {} }));
      assert.equal(r.status, 200, `pin "${pin}" matching the session (or absent) passes`);
    }
  });

  test("a read-only grant cannot write anything (403 on every write)", async () => {
    fake.contexts.set(employee.id, ctxFor(employee, "employee", READ_ONLY_PERMS));
    const c = cookie(employee);
    const writes = ROUTES.filter(([method]) => method !== "GET");
    assert.equal(writes.length, 17);
    for (const route of writes) {
      const r = await json(await call(route, c));
      assert.deepEqual([r.status, r.body.code], [403, "forbidden"], `${route[0]} ${route[1]}`);
    }
  });

  test("malformed ids, bodies, queries, and cursors are 422 with field errors; nothing is written", async () => {
    const c = cookie(owner);
    const byPath = (method: string, path: string) => ROUTES.find((r) => r[0] === method && r[1] === path)!;
    const cases: [Response, string][] = [
      [await (patchContactRoute as Handler)(req("/api/contacts/1;drop", { cookie: c, method: "PATCH", body: { firstName: "X" } }), params({ id: "1;drop" })), "id"],
      [await call(byPath("POST", "/api/contacts"), c, { body: { firstName: "X", ownerId: owner.id } }), "unknown key"],
      [await call(byPath("POST", "/api/contacts"), c, { body: "{not json" }), "json"],
      [await call(byPath("POST", "/api/contacts"), c, { body: { email: "nope" } }), "email"],
      [await call(byPath("GET", "/api/contacts"), c, { path: "/api/contacts?limit=1000" }), "limit"],
      [await call(byPath("GET", "/api/contacts"), c, { path: "/api/contacts?cursor=garbage" }), "cursor"],
      [await call(byPath("GET", "/api/contacts"), c, { path: "/api/contacts?select=*" }), "unknown query key"],
      [await call(byPath("POST", "/api/opportunities"), c, { body: { contactId: ID, stageId: ID2, title: "T", valueCents: 10.5 } }), "valueCents"],
      [await call(byPath("POST", `/api/opportunities/${ID}/move`), c, { body: { stageId: "Won" } }), "stageId"],
      [await call(byPath("POST", "/api/appointments"), c, { body: { calendarId: ID, contactId: ID2, startsAt: "2031-05-06T14:00:00Z", endsAt: "2031-05-06T13:00:00Z" } }), "endsAt"],
      [await call(byPath("PUT", `/api/calendars/${ID}/availability`), c, { body: { rules: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "10:00", end: "11:00" }] } }), "rules"],
      [await call(byPath("POST", "/api/tasks"), c, { body: { title: "T", status: "archived" } }), "status"],
      [await call(byPath("POST", `/api/conversations/${ID}/notes`), c, { body: { body: "x", direction: "outbound" } }), "direction"],
      [await call(byPath("GET", "/api/reports/summary"), c, { path: "/api/reports/summary?from=yesterday" }), "from"],
      // Valid JSON under a CORS-simple or missing content type is refused (no preflight would guard it).
      ...await Promise.all(([["text/plain", "POST"], ["application/x-www-form-urlencoded", "POST"], ["text/plain;charset=UTF-8", "PATCH"], [null, "POST"]] as const)
        .map(async ([contentType, method]): Promise<[Response, string]> => [
          method === "POST"
            ? await (createContactRoute as Handler)(req("/api/contacts", { cookie: c, method, body: { firstName: "X" }, contentType }), params())
            : await (patchContactRoute as Handler)(req(`/api/contacts/${ID}`, { cookie: c, method, body: { firstName: "X" }, contentType }), params({ id: ID })),
          `${method} as ${contentType ?? "unset (fetch defaults a string body to text/plain)"}`,
        ])),
    ];
    for (const [res, label] of cases) {
      const body = (await res.json()) as { code: string; fields?: Record<string, string> };
      assert.equal(res.status, 422, label);
      assert.equal(body.code, "validation_failed", label);
      assert.ok(body.fields && Object.keys(body.fields).length > 0, `${label}: fields present`);
    }
    assert.equal(fake.calls.some((x) => ["POST", "PATCH", "PUT", "DELETE"].includes(x.method) && !x.path.includes("/rpc/request_context")), false,
      "no write reached the database");
  });

  test("a workspace id in a body is dropped before the database: the write goes to the session's workspace", async () => {
    const seen: Record<string, unknown>[] = [];
    fake.rpc.save_contact = (args) => {
      seen.push(args);
      return { status: 200, body: "00000000-0000-4000-8000-00000000c0a1" };
    };
    const r = await json(await (createContactRoute as Handler)(
      req("/api/contacts", { cookie: cookie(owner), method: "POST", body: { firstName: "Ada", workspaceId: WS_B, workspace_id: WS_B } }), params()));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(seen.length, 1);
    assert.equal(JSON.stringify(seen[0]).includes(WS_B), false, "workspace B never reaches the database");
    assert.deepEqual(seen[0], { p_id: null, p_values: { first_name: "Ada" }, p_tags: null });
  });

  test("contacts list: only the caller's workspace, no deleted rows, newest first, exact total, opaque next cursor", async () => {
    const r = await json(await (listContactsRoute as Handler)(req("/api/contacts?limit=2", { cookie: cookie(owner) }), params()));
    assert.equal(r.status, 200);
    assert.deepEqual((r.body.items as { firstName: string }[]).map((c) => c.firstName), ["Edsger", "Grace"]);
    assert.equal(r.body.total, 3);
    assert.equal(typeof r.body.nextCursor, "string");
    assert.deepEqual(decodeKeyset(r.body.nextCursor as string), { t: "2031-01-02T00:00:00+00:00", id: "00000000-0000-4000-8000-00000000c0a2" });
    const text = JSON.stringify(r.body);
    assert.equal(text.includes("Bravo") || text.includes("Deleted"), false);
    const all = await json(await (listContactsRoute as Handler)(req(`/api/contacts?limit=50&workspace_id=${WS_B}`, { cookie: cookie(owner) }), params()));
    assert.deepEqual((all.body.items as { firstName: string }[]).map((c) => c.firstName), ["Edsger", "Grace", "Ada"],
      "a workspace id in the query is ignored; the session's workspace is used");
    assert.equal(all.body.nextCursor, null);
  });

  test("a contact of another workspace, or a deleted one, is 404 (never leaked)", async () => {
    for (const id of ["00000000-0000-4000-8000-00000000c0b1", "00000000-0000-4000-8000-00000000c0a4"]) {
      const r = await json(await (getContactRoute as Handler)(req(`/api/contacts/${id}`, { cookie: cookie(owner) }), params({ id })));
      assert.deepEqual([r.status, r.body.code], [404, "not_found"], id);
    }
  });

  test("database read failures are 503 unavailable, never an empty success", async () => {
    fake.faults.tableFails = "contacts";
    const r = await json(await (listContactsRoute as Handler)(req("/api/contacts", { cookie: cookie(owner) }), params()));
    assert.deepEqual([r.status, r.body.code], [503, "unavailable"]);
  });
});

describe("P5 legacy mode is unchanged", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AUTH_PROVIDER;
    process.env.AUTH_PROVIDER = "legacy";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = prev;
  });

  test("every P5 endpoint answers 404 in legacy mode", async () => {
    for (const route of ROUTES) assert.equal((await call(route)).status, 404, `${route[0]} ${route[1]}`);
  });
});

describe("P5 static guards", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
  const api = (d: string) => walk(join(ROOT, "src", "app", "api", d)).filter((f) => f.endsWith("route.ts"));
  const P5_ROUTES = ["contacts", "pipeline", "opportunities", "calendars", "appointments", "tasks", "conversations", "reviews", "reports"].flatMap(api);
  const P5_LIBS = ["records", "contacts", "opportunities", "calendars", "tasks", "conversations", "reviews", "reports"]
    .map((f) => join(ROOT, "src", "lib", "native", `${f}.ts`));
  const P5_UI = [...walk(join(ROOT, "src", "components", "records")), join(ROOT, "src", "lib", "ui", "native-api.ts")];

  test("every P5 route goes through nativeApi with a permission and never the service role", () => {
    assert.equal(P5_ROUTES.length, 20);
    for (const f of P5_ROUTES) {
      const src = readFileSync(f, "utf8");
      const handlers = src.match(/export async function (GET|POST|PATCH|PUT|DELETE)/g) ?? [];
      const guarded = src.match(/nativeApi\(req, \{ permission: "[a-z_]+\.[a-z_]+" \}/g) ?? [];
      assert.ok(handlers.length > 0 && guarded.length === handlers.length, `${rel(f)}: each handler calls nativeApi with a permission`);
      assert.equal(/supabase\/admin|SERVICE_ROLE|createAdminClient/.test(src), false, `${rel(f)} must not use the service role`);
    }
  });

  test("P5 libraries use the caller's JWT client only, and take the workspace from the context", () => {
    for (const f of P5_LIBS) {
      const src = readFileSync(f, "utf8");
      assert.equal(/supabase\/admin|SERVICE_ROLE|serviceRole/.test(src), false, `${rel(f)}: no service role`);
      assert.equal(/input\.workspace|query\.workspace|body\.workspace/i.test(src), false, `${rel(f)}: no client workspace id`);
    }
  });

  test("the workspace pin is only a precondition header; a workspace id is posted only to the switch route", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "ui", "workspace-pin.ts"), "utf8");
    assert.deepEqual(src.match(/"X-FNA-Workspace"/g), ['"X-FNA-Workspace"'], "the pin leaves the browser only as the precondition header");
    assert.deepEqual(src.match(/fetch\("[^"]+"/g), ['fetch("/api/workspaces/active"'], "the only request it makes is the switch");
    assert.deepEqual(src.match(/workspaceId:/g), ["workspaceId:"], "the switch body is the only workspace id it sends");
    const ctx = readFileSync(join(ROOT, "src", "lib", "authz", "context.ts"), "utf8");
    assert.match(ctx, /EXPECTED_WORKSPACE_HEADER = "x-fna-workspace"/);
    assert.equal((ctx.match(/EXPECTED_WORKSPACE_HEADER/g) ?? []).length, 2, "the server reads the header in one place, only to compare");
  });

  test("browser components never send a workspace id and never message anyone", () => {
    for (const f of P5_UI) {
      const src = readFileSync(f, "utf8");
      assert.equal(/workspace_?id/i.test(src), false, `${rel(f)}: no workspace id from the client`);
      assert.equal(/twilio|resend|sendgrid|nodemailer|mailto:|sms:|\/send\b|direction: "outbound"/i.test(src), false, `${rel(f)}: nothing outbound`);
    }
  });

  test("conversation notes are inserted as internal only; no code path writes outbound or sets delivery status", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "native", "conversations.ts"), "utf8");
    const inserts = src.match(/\.insert\(\{[^}]*\}\)/g) ?? [];
    assert.deepEqual(inserts, ['.insert({ workspace_id: activeWorkspaceId(scope), conversation_id: id, direction: "internal", body })']);
    assert.equal(/\.(update|upsert)\(/.test(src), false, "messages are never updated");
  });
});

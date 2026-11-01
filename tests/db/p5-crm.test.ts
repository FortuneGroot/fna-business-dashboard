import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { adminCount, asAnon, asServiceRole, asUser, buildWorld, createContact, rpc, rows, stageId, type TestUser, type World } from "./harness";

// P5 (migration 20261101001700): atomic contact / calendar / availability saves that run with the
// caller's own privileges, and activity events for record changes made with a user JWT. Every
// user call runs as role authenticated with that user's JWT claims; the superuser only verifies.

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

const saveContact = (u: TestUser, id: string | null, values: unknown, tags: string[] | null = null) =>
  asUser(w.db, u, (q) => rpc<string>(q, "save_contact", [id, JSON.stringify(values), tags]));
const saveCalendar = (u: TestUser, id: string | null, values: unknown, members: string[] | null = null) =>
  asUser(w.db, u, (q) => rpc<string>(q, "save_calendar", [id, JSON.stringify(values), members]));
const replaceAvailability = (u: TestUser, id: string, rules: unknown) =>
  asUser(w.db, u, (q) => rpc(q, "replace_availability", [id, JSON.stringify(rules)]));
const admin = <T>(sql: string, params: unknown[] = []) => rows<T>(w.db as never, sql, params);
const lastActivity = () => adminCount(w.db, "select coalesce(max(id), 0) n from public.activity_events");
type Activity = { entity_type: string; entity_id: string; action: string; actor_id: string | null; actor_kind: string; payload: Record<string, unknown> };
const activitySince = (id: number) =>
  admin<Activity>("select entity_type, entity_id, action, actor_id, actor_kind, payload from public.activity_events where id > $1 order by id", [id]);

describe("P5: save_contact", () => {
  test("creates and updates a contact with its tags in one call, in the caller's active workspace", async () => {
    const id = await saveContact(w.employeeA, null, { first_name: "Ada", email: "ada@example.test", phone: "555-0100" }, ["VIP", "towing"]);
    const [row] = await admin<{ workspace_id: string; first_name: string; email: string; created_by: string; source: string }>(
      "select workspace_id, first_name, email::text, created_by, source from public.contacts where id = $1", [id]);
    assert.deepEqual(row, { workspace_id: w.wsA, first_name: "Ada", email: "ada@example.test", created_by: w.employeeA.id, source: "manual" });
    const tags = async () => (await admin<{ tag: string }>("select tag::text from public.contact_tags where contact_id = $1 order by lower(tag::text)", [id])).map((t) => t.tag);
    assert.deepEqual(await tags(), ["towing", "VIP"]);

    await saveContact(w.adminA, id, { last_name: "Lovelace", phone: null });
    const [updated] = await admin<{ first_name: string; last_name: string; phone: string | null }>(
      "select first_name, last_name, phone from public.contacts where id = $1", [id]);
    assert.deepEqual(updated, { first_name: "Ada", last_name: "Lovelace", phone: null }, "only the given keys change");
    assert.deepEqual(await tags(), ["towing", "VIP"], "tags stay when p_tags is null");
    await saveContact(w.adminA, id, {}, ["Repeat"]);
    assert.deepEqual(await tags(), ["Repeat"], "tags are replaced when given");
  });

  test("malformed input, unknown keys, too many tags, and impossible contacts are refused", async () => {
    await assert.rejects(saveContact(w.ownerA, null, { first_name: "X", workspace_id: w.wsB }), /validation_failed/);
    await assert.rejects(saveContact(w.ownerA, null, { first_name: "X", created_by: w.ownerB.id }), /validation_failed/);
    await assert.rejects(saveContact(w.ownerA, null, ["first_name"]), /validation_failed/);
    await assert.rejects(saveContact(w.ownerA, null, { first_name: "X" }, Array.from({ length: 21 }, (_, i) => `t${i}`)), /validation_failed/);
    await assert.rejects(saveContact(w.ownerA, null, {}), /check constraint|violates/);
    await assert.rejects(saveContact(w.ownerA, null, { first_name: "X", owner_user_id: "nope" }), /invalid input syntax/);
  });

  test("owners must be active members of the same workspace; duplicate emails conflict", async () => {
    await assert.rejects(saveContact(w.ownerA, null, { first_name: "X", owner_user_id: w.employeeB.id }), /active member|foreign key/);
    await assert.rejects(saveContact(w.ownerA, null, { first_name: "X", owner_user_id: w.outsider.id }), /active member|foreign key/);
    const owned = await saveContact(w.ownerA, null, { first_name: "Owned", owner_user_id: w.employeeA.id });
    assert.equal((await admin<{ owner_user_id: string }>("select owner_user_id from public.contacts where id = $1", [owned]))[0].owner_user_id, w.employeeA.id);
    await saveContact(w.ownerA, null, { first_name: "Dup", email: "dup@example.test" });
    await assert.rejects(saveContact(w.employeeA, null, { first_name: "Dup 2", email: "DUP@example.test" }), /duplicate key|unique/);
  });

  test("another workspace's contact, a deleted contact, outsiders, and anonymous callers are refused", async () => {
    const foreign = await createContact(w.db, w.ownerB, w.wsB, "Foreign");
    await assert.rejects(saveContact(w.ownerA, foreign, { first_name: "Hijack" }), /not_found/);
    await assert.rejects(saveContact(w.ownerA, foreign, {}, ["x"]), /not_found/);
    assert.equal((await admin<{ first_name: string }>("select first_name from public.contacts where id = $1", [foreign]))[0].first_name, "Foreign");
    const gone = await saveContact(w.ownerA, null, { first_name: "Gone" });
    await asUser(w.db, w.ownerA, (q) => rpc(q, "soft_delete_contact", [gone]));
    await assert.rejects(saveContact(w.ownerA, gone, { first_name: "Back" }), /not_found/);
    await assert.rejects(saveContact(w.outsider, null, { first_name: "X" }), /forbidden/);
    await assert.rejects(asAnon(w.db, (q) => rpc(q, "save_contact", [null, JSON.stringify({ first_name: "X" }), null])), /permission denied/);
  });

  test("a contacts.write denial override applies to the RPC and clears again", async () => {
    await asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_permissions", [w.employeeA.id, JSON.stringify({ "contacts.write": false })]));
    try {
      await assert.rejects(saveContact(w.employeeA, null, { first_name: "Denied" }), /forbidden/);
    } finally {
      await asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_permissions", [w.employeeA.id, JSON.stringify({ "contacts.write": null })]));
    }
    await saveContact(w.employeeA, null, { first_name: "Allowed again" });
  });
});

describe("P5: save_calendar and replace_availability", () => {
  test("calendar.configure holders create and edit calendars with an exact member set", async () => {
    const id = await saveCalendar(w.ownerA, null, { name: "Tows", slug: "tows", timezone: "America/New_York", duration_minutes: 30 }, [w.employeeA.id, w.adminA.id]);
    const members = async () => (await admin<{ user_id: string }>("select user_id from public.calendar_members where calendar_id = $1 order by user_id", [id])).map((m) => m.user_id);
    assert.deepEqual(await members(), [w.employeeA.id, w.adminA.id].sort());
    await saveCalendar(w.adminA, id, { name: "Tows & Jumps", active: false }, [w.employeeA.id]);
    assert.deepEqual(await members(), [w.employeeA.id]);
    const [row] = await admin<{ name: string; active: boolean; duration_minutes: number }>("select name, active, duration_minutes from public.calendars where id = $1", [id]);
    assert.deepEqual(row, { name: "Tows & Jumps", active: false, duration_minutes: 30 });
    await saveCalendar(w.adminA, id, { active: true });
    assert.deepEqual(await members(), [w.employeeA.id], "members stay when p_member_ids is null");
  });

  test("employees, foreign members, foreign calendars, duplicate slugs, and bad values are refused", async () => {
    await assert.rejects(saveCalendar(w.employeeA, null, { name: "E", slug: "e", duration_minutes: 30 }), /forbidden/);
    await assert.rejects(saveCalendar(w.ownerA, null, { name: "F", slug: "f", duration_minutes: 30 }, [w.employeeB.id]), /active member|foreign key/);
    const foreign = await saveCalendar(w.ownerB, null, { name: "B cal", slug: "b-cal", duration_minutes: 60 });
    await assert.rejects(saveCalendar(w.ownerA, foreign, { name: "Hijack" }), /not_found/);
    await saveCalendar(w.ownerA, null, { name: "Dup", slug: "dup-slug", duration_minutes: 30 });
    await assert.rejects(saveCalendar(w.ownerA, null, { name: "Dup 2", slug: "dup-slug", duration_minutes: 30 }), /duplicate key|unique/);
    await assert.rejects(saveCalendar(w.ownerA, null, { name: "Bad", slug: "Bad Slug!", duration_minutes: 30 }), /check constraint/);
    await assert.rejects(saveCalendar(w.ownerA, null, { name: "Bad", slug: "bad", duration_minutes: 2 }), /check constraint/);
    await assert.rejects(saveCalendar(w.ownerA, null, { name: "Bad", slug: "bad", duration_minutes: 30, is_primary: true }), /validation_failed/);
  });

  test("availability is replaced atomically and validated; foreign calendars are not found", async () => {
    const id = await saveCalendar(w.ownerA, null, { name: "Avail", slug: "avail", duration_minutes: 30 });
    await replaceAvailability(w.adminA, id, [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "13:00", end: "17:00" }]);
    const rules = async () => admin<{ weekday: number; start_time: string; end_time: string }>(
      "select weekday, start_time::text, end_time::text from public.availability_rules where calendar_id = $1 order by weekday, start_time", [id]);
    assert.deepEqual(await rules(), [
      { weekday: 1, start_time: "09:00:00", end_time: "12:00:00" }, { weekday: 1, start_time: "13:00:00", end_time: "17:00:00" },
    ]);
    const before = await rules();
    await assert.rejects(replaceAvailability(w.adminA, id, [{ weekday: 2, start: "09:00", end: "08:00" }]), /check constraint/);
    await assert.rejects(replaceAvailability(w.adminA, id, [{ weekday: 7, start: "09:00", end: "10:00" }]), /validation_failed/);
    await assert.rejects(replaceAvailability(w.adminA, id, [{ weekday: 1, start: "9am", end: "10:00" }]), /validation_failed/);
    await assert.rejects(replaceAvailability(w.adminA, id, { weekday: 1 }), /validation_failed/);
    assert.deepEqual(await rules(), before, "a failed replacement keeps the previous rules");
    await assert.rejects(replaceAvailability(w.employeeA, id, []), /forbidden/);
    const foreign = await saveCalendar(w.ownerB, null, { name: "B avail", slug: "b-avail", duration_minutes: 30 });
    await assert.rejects(replaceAvailability(w.ownerA, foreign, []), /not_found/);
    await replaceAvailability(w.adminA, id, []);
    assert.deepEqual(await rules(), []);
  });
});

describe("P5: activity events", () => {
  test("contact create, update, note, and soft delete are recorded with the actor and changed field names only", async () => {
    const start = await lastActivity();
    const id = await saveContact(w.employeeA, null, { first_name: "Logged", email: "logged@example.test" });
    await saveContact(w.employeeA, id, { email: "logged2@example.test", dnd: true });
    await saveContact(w.employeeA, id, { dnd: true });
    await asUser(w.db, w.employeeA, (q) => rows(q, "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'Called back')", [w.wsA, id]));
    await asUser(w.db, w.ownerA, (q) => rpc(q, "soft_delete_contact", [id]));
    const events = await activitySince(start);
    assert.deepEqual(events.map((e) => [e.entity_type, e.entity_id, e.action, e.actor_id, e.actor_kind]), [
      ["contact", id, "created", w.employeeA.id, "member"],
      ["contact", id, "updated", w.employeeA.id, "member"],
      ["contact", id, "note_added", w.employeeA.id, "member"],
      ["contact", id, "deleted", w.ownerA.id, "member"],
    ], "an update that changes nothing is not recorded");
    assert.deepEqual(events[1].payload, { fields: ["dnd", "email"] });
    assert.equal(JSON.stringify(events).includes("logged2@example.test"), false, "values are never copied");
    assert.equal(JSON.stringify(events).includes("Called back"), false);
  });

  test("opportunity moves record the from/to stage ids; closing stages record won or lost", async () => {
    const contact = await createContact(w.db, w.ownerA, w.wsA, "Deal contact");
    const s1 = await stageId(w.db, w.ownerA, 1);
    const s2 = await stageId(w.db, w.ownerA, 2);
    const won = (await admin<{ id: string }>("select id from public.pipeline_stages where workspace_id = $1 and kind = 'won' limit 1", [w.wsA]))[0].id;
    const start = await lastActivity();
    const opp = await asUser(w.db, w.employeeA, async (q) =>
      (await rows<{ id: string }>(q, "insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title, value_cents) values ($1, $2, $3, $4, 'Tow job', 12345) returning id",
        [w.wsA, contact, s1.pipeline_id, s1.id]))[0].id);
    await asUser(w.db, w.employeeA, (q) => rows(q, "update public.opportunities set stage_id = $1 where id = $2", [s2.id, opp]));
    await asUser(w.db, w.employeeA, (q) => rows(q, "update public.opportunities set stage_id = $1 where id = $2", [won, opp]));
    const events = await activitySince(start);
    assert.deepEqual(events.map((e) => e.action), ["created", "stage_changed", "won"]);
    assert.deepEqual([events[1].payload.from_stage_id, events[1].payload.to_stage_id], [s1.id, s2.id]);
    assert.ok((events[2].payload.fields as string[]).includes("status"));
  });

  test("appointment and task transitions; internal notes; server writes without a JWT subject are not recorded", async () => {
    const contact = await createContact(w.db, w.ownerA, w.wsA, "Appt contact");
    const cal = await saveCalendar(w.ownerA, null, { name: "Activity cal", slug: "activity-cal", duration_minutes: 30 });
    const start = await lastActivity();
    const appt = await asUser(w.db, w.employeeA, async (q) =>
      (await rows<{ id: string }>(q, "insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at) values ($1, $2, $3, '2026-12-01T10:00Z', '2026-12-01T10:30Z') returning id",
        [w.wsA, cal, contact]))[0].id);
    await asUser(w.db, w.employeeA, (q) => rows(q, "update public.appointments set starts_at = '2026-12-01T11:00Z', ends_at = '2026-12-01T11:30Z' where id = $1", [appt]));
    await asUser(w.db, w.employeeA, (q) => rows(q, "update public.appointments set status = 'cancelled' where id = $1", [appt]));
    const task = await asUser(w.db, w.employeeA, async (q) =>
      (await rows<{ id: string }>(q, "insert into public.tasks (workspace_id, title) values ($1, 'Call back') returning id", [w.wsA]))[0].id);
    await asUser(w.db, w.employeeA, (q) => rows(q, "update public.tasks set status = 'done' where id = $1", [task]));
    const conversation = (await admin<{ id: string }>(
      "insert into public.conversations (workspace_id, contact_id, channel) values ($1, $2, 'sms') returning id", [w.wsA, contact]))[0].id;
    await asUser(w.db, w.employeeA, (q) => rows(q, "insert into public.messages (workspace_id, conversation_id, direction, body) values ($1, $2, 'internal', 'Note')", [w.wsA, conversation]));
    await asServiceRole(w.db, (q) => rows(q, "insert into public.messages (workspace_id, conversation_id, direction, body) values ($1, $2, 'inbound', 'Hi')", [w.wsA, conversation]));
    await asServiceRole(w.db, (q) => rows(q, "update public.tasks set title = 'Server edit' where id = $1", [task]));
    const events = await activitySince(start);
    assert.deepEqual(events.map((e) => [e.entity_type, e.action]), [
      ["appointment", "created"], ["appointment", "rescheduled"], ["appointment", "cancelled"],
      ["task", "created"], ["task", "completed"], ["conversation", "note_added"],
    ]);
    assert.equal(events.at(-1)!.entity_id, conversation);
  });

  test("clients cannot call the trigger function or write activity events directly", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rows(q, "select private.record_crm_activity()")), /permission denied/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) =>
      rows(q, "insert into public.activity_events (workspace_id, entity_type, action, actor_kind) values ($1, 'contact', 'created', 'member')", [w.wsA])), /permission denied/);
    for (const fn of ["save_contact(uuid, jsonb, text[])", "save_calendar(uuid, jsonb, uuid[])", "replace_availability(uuid, jsonb)"]) {
      const [grants] = await admin<{ anon: boolean; authed: boolean }>(
        `select has_function_privilege('anon', 'public.${fn}', 'execute') anon, has_function_privilege('authenticated', 'public.${fn}', 'execute') authed`);
      assert.deepEqual(grants, { anon: false, authed: true }, fn);
    }
  });
});

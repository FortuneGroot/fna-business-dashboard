// Local acceptance rehearsal across P1–P7 on a fresh disposable Supabase stack with two synthetic
// businesses. One ordered journey: each step uses the state the previous steps produced, through the
// real app (next build + next start) with each person's own cookies. The superuser connection only
// registers the platform admin (stands in for the bootstrap script), seeds one inbound conversation
// (native mode has no inbound channel yet), and verifies outcomes.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import {
  adminDb, appFetch, appLogin, cookieHeader, readSessionCookie, rest, signUp, startApp, startStack, totp,
  type App, type Identity, type Stack, type StackEnv,
} from "../supabase-stack/stack";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;
const HARBOR = "Harbor Plumbing (synthetic)";
const SUMMIT = "Summit Roofing (synthetic)";
const REASON = "Acceptance rehearsal support check";

type R = Awaited<ReturnType<typeof appFetch>>;
type Person = { email: string; password: string; id?: string; cookie: string };

let stack: Stack;
let env: StackEnv;
let db: pg.Client;
let app: App;

let admin: Identity;
let adminCookie = "";
let factorId = "";
let secret = "";
let lastCode = "";

let wsH = "";
let wsS = "";
let harborToken = "";
let summitToken = "";
const harborOwner: Person = { email: email("harbor-owner"), password: "Local-harbor-owner-1", cookie: "" };
let summitOwner: Person;
const dana: Person = { email: email("harbor-admin"), password: "Local-harbor-admin-1", cookie: "" };
const eli: Person = { email: email("harbor-employee"), password: "Local-harbor-employee-1", cookie: "" };
let casey: Person;

const stages: Record<string, string> = {};
const ids = { contact: "", opportunity: "", calendar: "", appointment: "", task: "", conversation: "", summitContact: "" };

const expect = (r: R, status: number, code: string | null, label: string) =>
  assert.deepEqual([r.status, code === null ? null : r.body?.code], [status, code], `${label}: ${r.text.slice(0, 240)}`);
const call = (cookie: string, method: string, path: string, json?: unknown) => appFetch(app, path, { method, cookie, json });
const ok = async (p: Promise<R>, label: string) => {
  const r = await p;
  assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 300)}`);
  return r;
};
const tokenOf = (url: unknown) => {
  const m = /^http:\/\/127\.0\.0\.1:\d+\/invite\/([0-9a-f]{64})$/.exec(String(url));
  assert.ok(m, `invite link: ${String(url)}`);
  return m![1];
};
const mergeCookies = (cookie: string, setCookies: string[]) => {
  const jar = new Map(cookie.split("; ").filter(Boolean).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const));
  for (const c of setCookies) {
    const pair = c.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (value === "" || /max-age=0\b/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
};
const freshCode = async () => {
  let c = totp(secret);
  while (c === lastCode) {
    await new Promise((r) => setTimeout(r, 1000));
    c = totp(secret);
  }
  lastCode = c;
  return c;
};
const login = (p: { email: string; password: string }) => appLogin(app, p as Identity);
const userId = async (address: string) =>
  (await db.query<{ id: string }>("select id from auth.users where email = $1", [address])).rows[0]?.id;
const counts = async (ws: string) =>
  (await db.query<Record<string, number>>(
    `select (select count(*)::int from public.contacts where workspace_id = $1) contacts,
            (select count(*)::int from public.opportunities where workspace_id = $1) opportunities,
            (select count(*)::int from public.appointments where workspace_id = $1) appointments,
            (select count(*)::int from public.tasks where workspace_id = $1) tasks,
            (select count(*)::int from public.calendars where workspace_id = $1) calendars,
            (select count(*)::int from public.workspace_invitations where workspace_id = $1) invitations,
            (select count(*)::int from public.workspace_members where workspace_id = $1) members`, [ws])).rows[0];
const plain = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("local acceptance rehearsal (P1–P7): two synthetic businesses on a fresh disposable stack", () => {
  before(async () => {
    stack = startStack();
    env = stack.env;
    db = await adminDb(env);
    app = await startApp(env);
    admin = await signUp(env, email("platform-admin"), "Acceptance Platform Admin");
    await db.query("insert into public.platform_admins (user_id) values ($1)", [admin.id]);
  });

  after(async () => {
    app?.stop();
    await db?.end().catch(() => undefined);
    stack?.stop();
  });

  test("1. platform admin: password session is refused, MFA enrolment in the app reaches AAL2", async () => {
    adminCookie = await appLogin(app, admin);
    expect(await call(adminCookie, "GET", "/api/platform/workspaces"), 403, "mfa_required", "AAL1 admin");
    const en = await ok(call(adminCookie, "POST", "/api/auth/mfa/enroll", {}), "enrol");
    ({ factorId, secret } = en.body);
    const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, "0");
    expect(await call(adminCookie, "POST", "/api/auth/mfa/verify", { factorId, code: wrong }), 422, "validation_failed", "wrong code");
    const v = await ok(call(adminCookie, "POST", "/api/auth/mfa/verify", { factorId, code: await freshCode() }), "verify");
    assert.deepEqual([v.body.aal, v.body.platformActive], ["aal2", true]);
    adminCookie = mergeCookies(adminCookie, v.setCookies);
    await ok(call(adminCookie, "GET", "/api/platform/workspaces"), "console after MFA");
    const page = await appFetch(app, "/platform", { cookie: adminCookie });
    assert.equal(page.status, 200);
    assert.equal(/class="sidebar/.test(page.text), false, "the console is outside the client sidebar");
  });

  test("2. provisioning: two businesses, owner links shown once, a repeat is idempotent", async () => {
    const harbor = { provisioningKey: `acc-harbor-${run}`, name: HARBOR, slug: `harbor-${run}`, ownerEmail: harborOwner.email };
    const h = await ok(call(adminCookie, "POST", "/api/platform/workspaces", harbor), "provision Harbor");
    assert.equal(h.body.created, true);
    wsH = h.body.workspaceId;
    harborToken = tokenOf(h.body.inviteUrl);
    assert.deepEqual((await ok(call(adminCookie, "POST", "/api/platform/workspaces", harbor), "repeat")).body,
      { ok: true, workspaceId: wsH, created: false, inviteUrl: null }, "a repeat creates nothing and shows no link");

    summitOwner = { email: email("summit-owner"), password: "", cookie: "" };
    const s = await ok(call(adminCookie, "POST", "/api/platform/workspaces",
      { provisioningKey: `acc-summit-${run}`, name: SUMMIT, slug: `summit-${run}`, ownerEmail: summitOwner.email }), "provision Summit");
    wsS = s.body.workspaceId;
    summitToken = tokenOf(s.body.inviteUrl);
    const list = await ok(call(adminCookie, "GET", `/api/platform/workspaces?q=${run}&limit=10`), "search");
    assert.deepEqual(list.body.items.map((w: { id: string }) => w.id).sort(), [wsH, wsS].sort());
    const detail = await ok(call(adminCookie, "GET", `/api/platform/workspaces/${wsH}`), "detail");
    assert.equal(/[0-9a-f]{64}|token_hash|invite_token/.test(detail.text), false, "no invitation token after creation");
    assert.equal((await db.query("select count(*)::int n from public.pipeline_stages where workspace_id = $1", [wsH])).rows[0].n, 12);
  });

  test("3. invitation acceptance: a new account (Harbor) and an existing account (Summit)", async () => {
    const preview = await appFetch(app, `/api/invitations/${harborToken}`);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.text.includes(harborOwner.email), false, "the preview masks the email");
    const joined = await appFetch(app, `/api/invitations/${harborToken}/accept`, { method: "POST", json: { password: harborOwner.password } });
    assert.equal(joined.status, 200, joined.text);
    harborOwner.cookie = cookieHeader(joined.setCookies);
    harborOwner.id = await userId(harborOwner.email);
    const me = await ok(call(harborOwner.cookie, "GET", "/api/auth/me"), "owner me");
    assert.deepEqual([me.body.role, me.body.workspace.id], ["owner", wsH]);
    expect(await appFetch(app, `/api/invitations/${harborToken}/accept`, { method: "POST", json: { password: "Another-pass-123" } }),
      410, "invitation_used", "the link works once");

    const existing = await signUp(env, summitOwner.email, "Summit Owner");
    summitOwner.password = existing.password;
    summitOwner.id = existing.id;
    summitOwner.cookie = await login(summitOwner);
    expect(await call(summitOwner.cookie, "GET", "/api/contacts"), 403, "no_active_workspace", "before accepting");
    const noAccess = await appFetch(app, "/dashboard", { cookie: summitOwner.cookie });
    assert.equal(new URL(noAccess.location!, app.url).pathname, "/no-access");
    await ok(appFetch(app, `/api/invitations/${summitToken}/accept`, { method: "POST", cookie: summitOwner.cookie, json: {} }), "accept Summit");
    assert.equal((await ok(call(summitOwner.cookie, "GET", "/api/auth/me"), "summit me")).body.workspace.id, wsS);
    const after = await ok(call(adminCookie, "GET", `/api/platform/workspaces/${wsH}`), "detail after join");
    assert.equal(after.body.workspace.canRotateBootstrap, false, "the bootstrap link cannot be replaced once an owner joined");
  });

  test("4. team: owner invites an admin, an employee, and a member of both businesses; roles apply", async () => {
    for (const [p, role] of [[dana, "admin"], [eli, "employee"]] as const) {
      const inv = await ok(call(harborOwner.cookie, "POST", "/api/team/invitations", { email: p.email, role }), `invite ${role}`);
      const j = await appFetch(app, `/api/invitations/${tokenOf(inv.body.inviteUrl)}/accept`, { method: "POST", json: { password: p.password } });
      assert.equal(j.status, 200, j.text);
      p.cookie = cookieHeader(j.setCookies);
      p.id = await userId(p.email);
    }
    const consultant = await signUp(env, email("casey"), "Casey Consultant");
    casey = { email: consultant.email, password: consultant.password, id: consultant.id, cookie: await login(consultant) };
    for (const [owner, role] of [[harborOwner, "employee"], [summitOwner, "admin"]] as const) {
      const inv = await ok(call(owner.cookie, "POST", "/api/team/invitations", { email: casey.email, role }), `invite Casey ${role}`);
      await ok(appFetch(app, `/api/invitations/${tokenOf(inv.body.inviteUrl)}/accept`, { method: "POST", cookie: casey.cookie, json: {} }), "Casey accepts");
    }
    const team = await ok(call(harborOwner.cookie, "GET", "/api/team"), "team");
    assert.deepEqual(team.body.members.map((m: { email: string; role: string }) => `${m.role}:${m.email}`).sort(),
      [`admin:${dana.email}`, `employee:${casey.email}`, `employee:${eli.email}`, `owner:${harborOwner.email}`].sort());

    expect(await call(eli.cookie, "POST", "/api/team/invitations", { email: email("x"), role: "employee" }), 403, "forbidden", "employee invites");
    expect(await call(dana.cookie, "PATCH", `/api/team/${eli.id}`, { role: "admin" }), 403, "forbidden", "admin promotes");
    expect(await call(eli.cookie, "PATCH", "/api/settings/workspace", { industry: "Plumbing" }), 403, "forbidden", "employee edits settings");
    await ok(call(harborOwner.cookie, "PATCH", "/api/settings/workspace", { industry: "Plumbing", businessPhone: "781-964-0654" }), "owner settings");
    assert.equal((await ok(call(dana.cookie, "GET", "/api/settings/workspace"), "admin reads settings")).body.settings.industry, "Plumbing");
    const eliPage = await appFetch(app, "/onboarding", { cookie: eli.cookie });
    assert.equal(new URL(eliPage.location!, app.url).pathname, "/dashboard", "Setup is hidden for employees");
  });

  test("5. records: contacts, opportunities, calendars, appointments, tasks, and inbox notes across roles", async () => {
    const c = await ok(call(eli.cookie, "POST", "/api/contacts", { firstName: "Rita", lastName: "Leak", email: `rita-${run}@example.test`, tags: ["emergency"] }), "contact");
    ids.contact = c.body.contact.id;
    await ok(call(eli.cookie, "POST", `/api/contacts/${ids.contact}/notes`, { body: "Basement flooding; call before 9am" }), "contact note");
    const p = await ok(call(harborOwner.cookie, "GET", "/api/pipeline"), "pipeline");
    for (const s of p.body.pipeline.stages) stages[s.name] = s.id;
    assert.equal(Object.keys(stages).length, 12);
    const o = await ok(call(eli.cookie, "POST", "/api/opportunities",
      { contactId: ids.contact, stageId: stages["New Lead"], title: "Sump pump", valueCents: 240000, assignedUserId: eli.id }), "opportunity");
    ids.opportunity = o.body.opportunity.id;
    const won = await ok(call(dana.cookie, "POST", `/api/opportunities/${ids.opportunity}/move`, { stageId: stages["Won"] }), "move");
    assert.deepEqual([won.body.opportunity.status, won.body.opportunity.valueCents], ["won", 240000]);

    expect(await call(eli.cookie, "POST", "/api/calendars", { name: "X", slug: `x-${run}`, timezone: "UTC", durationMinutes: 30 }), 403, "forbidden", "employee creates calendar");
    const cal = await ok(call(harborOwner.cookie, "POST", "/api/calendars",
      { name: "Service calls", slug: `service-${run}`, timezone: "America/New_York", durationMinutes: 60, memberUserIds: [eli.id] }), "calendar");
    ids.calendar = cal.body.calendar.id;
    await ok(call(harborOwner.cookie, "PUT", `/api/calendars/${ids.calendar}/availability`, { rules: [{ weekday: 2, start: "08:00", end: "16:00" }] }), "hours");
    const appt = await ok(call(eli.cookie, "POST", "/api/appointments",
      { calendarId: ids.calendar, contactId: ids.contact, startsAt: "2031-07-08T09:00:00-04:00", endsAt: "2031-07-08T10:00:00-04:00", assignedUserId: eli.id }), "booking");
    ids.appointment = appt.body.appointment.id;
    expect(await call(eli.cookie, "POST", "/api/appointments",
      { calendarId: ids.calendar, contactId: ids.contact, startsAt: "2031-07-08T13:30:00Z", endsAt: "2031-07-08T14:30:00Z" }), 409, "overlap", "double booking");

    const t = await ok(call(dana.cookie, "POST", "/api/tasks", { title: "Order replacement pump", assignedUserId: eli.id, dueAt: "2031-07-07T17:00:00-04:00" }), "task");
    ids.task = t.body.task.id;
    assert.equal((await ok(call(eli.cookie, "PATCH", `/api/tasks/${ids.task}`, { status: "done" }), "complete")).body.task.status, "done");

    ids.conversation = (await db.query<{ id: string }>(
      "insert into public.conversations (workspace_id, contact_id, channel, status) values ($1, $2, 'sms', 'open') returning id", [wsH, ids.contact])).rows[0].id;
    await db.query("insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status) values ($1, $2, 'inbound', 'Is Tuesday 9am ok?', 'delivered')",
      [wsH, ids.conversation]);
    const note = await ok(call(eli.cookie, "POST", `/api/conversations/${ids.conversation}/notes`, { body: "Confirmed Tuesday by phone" }), "inbox note");
    assert.equal(note.body.message?.direction ?? note.body.note?.direction ?? "internal", "internal");
    const thread = await ok(call(harborOwner.cookie, "GET", `/api/conversations/${ids.conversation}/messages?limit=10`), "thread");
    assert.equal(thread.body.items.length, 2);

    const summary = await ok(call(harborOwner.cookie, "GET", "/api/dashboard/summary"), "summary");
    assert.deepEqual([summary.body.summary.contactsCount, summary.body.summary.opportunitiesCount, summary.body.summary.appointmentsCount], [1, 1, 1]);
    const activity = await db.query<{ entity_id: string; action: string; actor_id: string }>(
      "select entity_id, action, actor_id from public.activity_events where workspace_id = $1 order by id", [wsH]);
    const by = (entity: string, action: string) => activity.rows.find((a) => a.entity_id === entity && a.action === action)?.actor_id;
    assert.deepEqual([by(ids.contact, "created"), by(ids.opportunity, "won"), by(ids.task, "completed")], [eli.id, dana.id, eli.id],
      "each action is attributed to the person who did it");
    for (const route of ["/contacts", "/pipeline", "/calendar", "/tasks", "/inbox"]) {
      const page = await appFetch(app, route, { cookie: harborOwner.cookie });
      assert.equal(page.status, 200, route);
      assert.ok(page.text.includes('class="sidebar'), `${route} keeps the original sidebar`);
    }
  });

  test("6. permission overrides: granting and then denying contacts.delete applies on the next request", async () => {
    const extra = await ok(call(eli.cookie, "POST", "/api/contacts", { firstName: "Temp", lastName: "Lead" }), "temp contact");
    expect(await call(eli.cookie, "DELETE", `/api/contacts/${extra.body.contact.id}`), 403, "forbidden", "employee deletes by default");
    await ok(call(dana.cookie, "PATCH", `/api/team/${eli.id}`, { overrides: { "contacts.delete": true } }), "grant override");
    await ok(call(eli.cookie, "DELETE", `/api/contacts/${extra.body.contact.id}`), "delete with override");
    await ok(call(dana.cookie, "PATCH", `/api/team/${eli.id}`, { overrides: { "contacts.delete": false } }), "deny override");
    expect(await call(eli.cookie, "DELETE", `/api/contacts/${ids.contact}`), 403, "forbidden", "after the override is denied");
    expect(await call(dana.cookie, "PATCH", `/api/team/${eli.id}`, { overrides: { "team.remove": true } }), 422, "validation_failed", "team.* cannot be granted");
    const audit = await ok(call(harborOwner.cookie, "GET", "/api/audit?limit=100"), "audit");
    const overrides = audit.body.items.filter((a: { action: string; target: string }) => a.action === "member.permission_override" && a.target === eli.id);
    assert.equal(overrides.length, 2);
    assert.ok(overrides.every((a: { actorId: string }) => a.actorId === dana.id), "override changes are attributed to the admin");
  });

  test("7. workspace switching: a member of both businesses sees only the active one", async () => {
    const list = await ok(call(casey.cookie, "GET", "/api/workspaces"), "workspaces");
    assert.deepEqual(list.body.workspaces.map((w: { id: string; role: string }) => `${w.id}:${w.role}`).sort(), [`${wsH}:employee`, `${wsS}:admin`].sort());
    ids.summitContact = (await ok(call(summitOwner.cookie, "POST", "/api/contacts", { firstName: "Sam", lastName: "Shingle" }), "summit contact")).body.contact.id;
    for (const [ws, mine, theirs] of [[wsH, ids.contact, ids.summitContact], [wsS, ids.summitContact, ids.contact]] as const) {
      await ok(call(casey.cookie, "POST", "/api/workspaces/active", { workspaceId: ws }), `switch to ${ws}`);
      const contacts = await ok(call(casey.cookie, "GET", "/api/contacts?limit=50"), "contacts");
      assert.deepEqual(contacts.body.items.map((c: { id: string }) => c.id), [mine]);
      expect(await call(casey.cookie, "GET", `/api/contacts/${theirs}`), 404, "not_found", "the other business's contact");
      // /api/tenant/public is deliberately generic in supabase mode (§7.3); the workspace name is authenticated.
      const brand = await ok(call(casey.cookie, "GET", "/api/tenant/config"), "workspace config");
      assert.equal(brand.body.client.businessName, ws === wsH ? HARBOR : SUMMIT, "the workspace name follows the active workspace");
    }
    expect(await call(eli.cookie, "POST", "/api/workspaces/active", { workspaceId: wsS }), 403, "forbidden", "switching into a business you are not in");
    expect(await call(eli.cookie, "GET", `/api/contacts/${ids.summitContact}`), 404, "not_found", "foreign id");
  });

  test("8. malformed requests: every mutating route answers a JSON 4xx, never 5xx, and writes nothing", async () => {
    const before = await counts(wsH);
    const zero = "00000000-0000-4000-8000-000000000000";
    const owner: [string, string][] = [
      ["POST", "/api/contacts"], ["PATCH", `/api/contacts/${ids.contact}`], ["POST", `/api/contacts/${ids.contact}/notes`],
      ["POST", "/api/opportunities"], ["PATCH", `/api/opportunities/${ids.opportunity}`], ["POST", `/api/opportunities/${ids.opportunity}/move`],
      ["PATCH", `/api/pipeline/stages/${stages["New Lead"]}`], ["POST", "/api/calendars"], ["PATCH", `/api/calendars/${ids.calendar}`],
      ["PUT", `/api/calendars/${ids.calendar}/availability`], ["POST", "/api/appointments"], ["PATCH", `/api/appointments/${ids.appointment}`],
      ["POST", "/api/tasks"], ["PATCH", `/api/tasks/${ids.task}`], ["POST", `/api/conversations/${ids.conversation}/notes`],
      ["PATCH", "/api/settings/workspace"], ["PUT", "/api/settings/ai-receptionist"], ["POST", "/api/team/invitations"],
      ["PATCH", `/api/team/${eli.id}`], ["POST", "/api/workspaces/active"], ["POST", "/api/auth/login"],
      ["POST", `/api/invitations/${"0".repeat(64)}/accept`],
    ];
    const platform: [string, string][] = [
      ["POST", "/api/platform/workspaces"], ["POST", `/api/platform/workspaces/${wsH}/suspend`], ["POST", `/api/platform/workspaces/${wsH}/reactivate`],
      ["POST", `/api/platform/workspaces/${wsH}/access`], ["POST", `/api/platform/workspaces/${wsH}/bootstrap-invitation`],
      ["DELETE", `/api/platform/access/${zero}`], ["POST", "/api/auth/mfa/verify"],
    ];
    const bodies: [string, string][] = [
      ["{", "application/json"], ["[]", "application/json"], ['"text"', "application/json"], ["null", "application/json"],
      ['{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}', "application/json"],
      [JSON.stringify({ firstName: "x".repeat(20000) }), "application/json"], ['{"firstName":"X"}', "text/plain"],
    ];
    const failures: string[] = [];
    for (const [cookie, routes] of [[harborOwner.cookie, owner], [adminCookie, platform]] as const) {
      for (const [method, path] of routes) {
        for (const [body, contentType] of bodies) {
          const r = await appFetch(app, path, { method, cookie, body, contentType });
          if (r.status >= 500 || r.status < 400 || typeof r.body?.code !== "string") failures.push(`${method} ${path} ${body.slice(0, 20)} -> ${r.status} ${r.text.slice(0, 80)}`);
        }
      }
    }
    for (const path of ["/api/contacts/not-a-uuid", "/api/opportunities/not-a-uuid", `/api/tasks/${zero}`, "/api/team/not-a-uuid"]) {
      const r = await call(harborOwner.cookie, path.startsWith("/api/tasks") ? "PATCH" : "DELETE", path, { status: "done" });
      if (r.status >= 500 || r.status < 400) failures.push(`${path} -> ${r.status}`);
    }
    for (const path of ["/api/contacts?limit=-1", "/api/contacts?limit=abc", "/api/contacts?cursor=%25%25%25", "/api/tasks?status=bogus",
      "/api/appointments?from=garbage&to=x", "/api/audit?limit=99999", `/api/conversations/${ids.conversation}/messages?cursor=junk`,
      "/api/opportunities?stageId=nope", "/api/dashboard/contacts?limit=-5"]) {
      const r = await call(harborOwner.cookie, "GET", path);
      if (r.status >= 500 || ![200, 400, 422].includes(r.status)) failures.push(`GET ${path} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    for (const path of ["/api/platform/workspaces?cursor=junk", "/api/platform/workspaces?limit=0", "/api/platform/audit?cursor=-1"]) {
      const r = await call(adminCookie, "GET", path);
      if (r.status >= 500 || ![200, 400, 422].includes(r.status)) failures.push(`GET ${path} -> ${r.status} ${r.text.slice(0, 80)}`);
    }
    assert.deepEqual(failures, [], "malformed requests that were not a JSON 4xx");
    assert.deepEqual(await counts(wsH), before, "malformed requests wrote nothing");
    expect(await call(harborOwner.cookie, "GET", "/api/no-such-route"), 404, null, "unknown API path");
    const missing = await appFetch(app, "/no-such-page", { cookie: harborOwner.cookie });
    assert.equal(missing.status, 404);
  });

  test("9. concurrency: duplicate creations and simultaneous moves settle to one consistent outcome", async () => {
    const address = `dup-${run}@example.test`;
    const racers = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      call(i % 2 ? eli.cookie : dana.cookie, "POST", "/api/contacts", { firstName: `Dup${i}`, email: address })));
    assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409, 409, 409, 409], racers.map((r) => r.text.slice(0, 80)).join(" | "));
    assert.ok(racers.filter((r) => r.status === 409).every((r) => r.body.code === "duplicate_email"));
    const moves = await Promise.all(["Qualified", "Estimate / Proposal Sent", "Lost", "Won"].map((s) =>
      call(dana.cookie, "POST", `/api/opportunities/${ids.opportunity}/move`, { stageId: stages[s] })));
    assert.ok(moves.every((m) => m.status === 200), moves.map((m) => m.text.slice(0, 80)).join(" | "));
    const final = await ok(call(harborOwner.cookie, "GET", `/api/opportunities/${ids.opportunity}`), "final opportunity");
    const row = (await db.query<{ stage_id: string; status: string }>("select stage_id, status from public.opportunities where id = $1", [ids.opportunity])).rows[0];
    assert.equal(final.body.opportunity.stageId, row.stage_id, "the API and the database agree on the final stage");
    const expected = row.stage_id === stages["Won"] ? "won" : row.stage_id === stages["Lost"] ? "lost" : "open";
    assert.equal(row.status, expected, "status matches the final stage");
  });

  test("10. pagination: keyset pages over tasks have no overlap and exact totals", async () => {
    for (let i = 0; i < 5; i++) await ok(call(dana.cookie, "POST", "/api/tasks", { title: `Paged ${i}`, assignedUserId: eli.id }), `task ${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: R = await ok(call(harborOwner.cookie, "GET", `/api/tasks?status=open&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), "page");
      seen.push(...r.body.items.map((t: { id: string }) => t.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(new Set(seen).size, seen.length, "no task appears twice");
    assert.equal(seen.length, 5, "every open task is listed once");
    assert.equal(pages, 3);
  });

  test("11. platform support: read grant reads with the banner, write grant is attributed, ending and expiry apply", async () => {
    const read = await ok(call(adminCookie, "POST", `/api/platform/workspaces/${wsH}/access`, { mode: "read", reason: REASON, durationMinutes: 15 }), "read grant");
    const page = await appFetch(app, "/dashboard", { cookie: adminCookie });
    assert.equal(page.status, 200);
    assert.match(plain(page.text), new RegExp(`Platform support access: ${HARBOR.replace(/[()]/g, "\\$&")}.*Read-only.*expires.*UTC`));
    assert.equal((await ok(call(adminCookie, "GET", "/api/contacts"), "read")).body.items.some((c: { id: string }) => c.id === ids.contact), true);
    expect(await call(adminCookie, "POST", "/api/contacts", { firstName: "Nope" }), 403, "forbidden", "read grant writes");
    expect(await call(adminCookie, "GET", `/api/contacts/${ids.summitContact}`), 404, "not_found", "other workspace during the grant");
    expect(await call(adminCookie, "DELETE", `/api/platform/access/${read.body.grant.id}`, {}), 422, "validation_failed", "ending needs a reason");
    await ok(call(adminCookie, "DELETE", `/api/platform/access/${read.body.grant.id}`, { reason: "Support session finished" }), "end read grant");
    expect(await call(adminCookie, "GET", "/api/contacts"), 403, "no_active_workspace", "after ending");

    const write = await ok(call(adminCookie, "POST", `/api/platform/workspaces/${wsH}/access`, { mode: "write", reason: REASON, durationMinutes: 1 }), "write grant");
    const made = await ok(call(adminCookie, "POST", "/api/contacts", { firstName: "Support", lastName: "Fix" }), "write under grant");
    const audit = await db.query<{ actor_id: string; actor_kind: string; grant_id: string }>(
      "select actor_id, actor_kind, grant_id from public.workspace_audit_log where workspace_id = $1 and target = $2", [wsH, made.body.contact.id]);
    assert.ok(audit.rows.some((a) => a.actor_id === admin.id && a.actor_kind === "platform_admin" && a.grant_id === write.body.grant.id),
      `support writes are attributed to the admin and the grant: ${JSON.stringify(audit.rows)}`);
    const ownerView = await ok(call(harborOwner.cookie, "GET", "/api/audit?limit=100"), "owner audit");
    assert.ok(ownerView.body.items.some((a: { actorKind: string }) => a.actorKind === "platform_admin"), "the owner sees support activity");
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(write.body.grant.expiresAt) - Date.now()) + 1500));
    expect(await call(adminCookie, "POST", "/api/contacts", { firstName: "Late" }), 403, "no_active_workspace", "after the clock expiry");
    const platformAudit = await db.query<{ action: string; reason: string | null; actor_id: string }>(
      "select action, reason, actor_id from public.platform_audit_log where workspace_id = $1 order by id", [wsH]);
    const actions = platformAudit.rows.map((a) => a.action);
    for (const a of ["workspace.provisioned"]) assert.ok(actions.includes(a), `${a} in ${actions}`);
    assert.ok(platformAudit.rows.filter((a) => /grant|access/.test(a.action)).every((a) => a.actor_id === admin.id && a.reason),
      `grant entries carry the admin and a reason: ${JSON.stringify(platformAudit.rows)}`);
  });

  test("12. suspension: members are blocked, a dual member can still work in the other business, reactivation restores", async () => {
    expect(await call(adminCookie, "POST", `/api/platform/workspaces/${wsS}/suspend`, {}), 422, "validation_failed", "suspension needs a reason");
    await ok(call(adminCookie, "POST", `/api/platform/workspaces/${wsS}/suspend`, { reason: REASON }), "suspend");
    expect(await call(summitOwner.cookie, "GET", "/api/contacts"), 423, "workspace_suspended", "owner read");
    expect(await call(summitOwner.cookie, "POST", "/api/contacts", { firstName: "Blocked" }), 423, "workspace_suspended", "owner write");
    const page = await appFetch(app, "/dashboard", { cookie: summitOwner.cookie });
    assert.equal(new URL(page.location!, app.url).pathname, "/workspace-suspended");
    await ok(call(casey.cookie, "POST", "/api/workspaces/active", { workspaceId: wsH }), "dual member switches to Harbor");
    await ok(call(casey.cookie, "GET", "/api/contacts"), "Harbor still works");
    await ok(call(adminCookie, "POST", `/api/platform/workspaces/${wsS}/reactivate`, { reason: REASON }), "reactivate");
    const back = await ok(call(summitOwner.cookie, "GET", "/api/contacts"), "after reactivation");
    assert.deepEqual(back.body.items.map((c: { id: string }) => c.id), [ids.summitContact], "records are intact");
    const actions = (await db.query<{ action: string; actor_id: string; reason: string }>(
      "select action, actor_id, reason from public.platform_audit_log where workspace_id = $1 and action in ('workspace.suspended','workspace.reactivated') order by id", [wsS])).rows;
    assert.deepEqual(actions.map((a) => [a.action, a.actor_id, a.reason]), [["workspace.suspended", admin.id, REASON], ["workspace.reactivated", admin.id, REASON]]);
  });

  test("13. access removal: a removed employee loses access on the next request and open work is unassigned", async () => {
    const open = await ok(call(dana.cookie, "POST", "/api/tasks", { title: "Leftover", assignedUserId: eli.id }), "open task");
    await ok(call(dana.cookie, "DELETE", `/api/team/${eli.id}`), "remove employee");
    expect(await call(eli.cookie, "GET", "/api/contacts"), 403, "no_active_workspace", "removed employee's same session");
    const page = await appFetch(app, "/contacts", { cookie: eli.cookie });
    assert.equal(new URL(page.location!, app.url).pathname, "/no-access");
    const task = (await db.query<{ assigned_user_id: string | null }>("select assigned_user_id from public.tasks where id = $1", [open.body.task.id])).rows[0];
    assert.equal(task.assigned_user_id, null);
    const audit = await ok(call(harborOwner.cookie, "GET", "/api/audit?limit=100"), "audit");
    assert.ok(audit.body.items.some((a: { action: string; target: string; actorId: string }) =>
      a.action === "member.removed" && a.target === eli.id && a.actorId === dana.id), "the removal is attributed to the admin");
    const done = (await db.query<{ status: string }>("select status from public.tasks where id = $1", [ids.task])).rows[0];
    assert.equal(done.status, "done", "completed work keeps its history");
  });

  test("14. logout ends the session at once: a replayed cookie or token can neither read nor write (M21)", async () => {
    // Browser tabs share one cookie jar, so a second open tab replays exactly this cookie.
    const throwaway = await login(dana);
    const { session } = readSessionCookie(throwaway);
    await ok(call(throwaway, "GET", "/api/contacts"), "before logout");
    assert.equal((await call(throwaway, "POST", "/api/auth/logout")).status, 200);
    assert.equal((await appFetch(app, "/api/auth/me")).body.user, null);

    const read = await call(throwaway, "GET", "/api/contacts");
    const write = await call(throwaway, "POST", "/api/contacts", { firstName: "Replay", lastName: "Check" });
    const sensitive = await call(throwaway, "POST", "/api/team/invitations", { email: email("replay"), role: "employee" });
    console.log(`LOGOUT-REPLAY: read ${read.status}, record write ${write.status}, invitation ${sensitive.status}`);
    expect(read, 401, "unauthenticated", "replayed cookie read");
    expect(write, 401, "unauthenticated", "replayed cookie write");
    expect(sensitive, 401, "unauthenticated", "replayed cookie sensitive action");
    assert.ok(read.setCookies.some((c) => /^sb-.+-auth-token/.test(c) && /Max-Age=0/i.test(c)), "the stale cookie is expired");
    const page = await appFetch(app, "/contacts", { cookie: throwaway });
    assert.equal(page.status, 307);
    assert.equal(new URL(page.location!, app.url).pathname, "/login");
    assert.ok(page.setCookies.some((c) => /^sb-.+-auth-token/.test(c) && /Max-Age=0/i.test(c)), "the page redirect expires the stale cookie");

    // The raw access token, straight at the Data API (bypassing the app), is refused too.
    const restRead = await rest(env, session.access_token, "GET", "contacts?select=id&limit=1");
    const restWrite = await rest(env, session.access_token, "POST", "contacts", { workspace_id: wsH, first_name: "Replay" });
    const restCtx = await rest(env, session.access_token, "POST", "rpc/request_context", {});
    assert.deepEqual([restRead.status, restWrite.status, restCtx.status], [401, 401, 401], restRead.text.slice(0, 200));
    // The session's refresh token was revoked with it, so the replay cannot mint a new access token.
    const refresh = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: env.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    assert.notEqual(refresh.status, 200, "revoked refresh token");
    await refresh.body?.cancel();
    const replayed = await db.query("select 1 from public.contacts where first_name = 'Replay'");
    assert.equal(replayed.rowCount, 0, "nothing was written by the replay");

    assert.equal((await ok(call(dana.cookie, "GET", "/api/auth/me"), "other session")).body.user.email, dana.email, "other sessions continue");
    await ok(call(dana.cookie, "GET", "/api/contacts"), "other session reads");
  });

  test("15. legacy mode: the same build starts without any Supabase, auth, or GHL setting and serves no retired route", async () => {
    const legacy = await startApp(env, { mode: "legacy", build: false });
    try {
      const health = await appFetch(legacy, "/api/health");
      assert.equal(health.status, 200, health.text);
      assert.deepEqual([health.body.ok, health.body.authProvider, health.body.storageMode], [true, "legacy", "memory"]);
      assert.equal(/ghl|crm|location|dryRun/i.test(Object.keys(health.body).join(",")), false);
      for (const [method, path] of [["GET", "/api/ghl/health"], ["POST", "/api/webhooks/ghl"], ["POST", "/api/leads"], ["GET", "/api/sync/health"],
        ["GET", "/api/events"], ["GET", "/api/onboarding/readiness"], ["GET", "/ghl-custom.css"]]) {
        assert.equal((await appFetch(legacy, path, { method, json: method === "POST" ? {} : undefined })).status, 404, `${method} ${path}`);
      }
      for (const path of ["/api/platform/workspaces", "/platform"]) assert.equal((await appFetch(legacy, path)).status, 404, `${path} in legacy mode`);
      assert.equal((await appFetch(legacy, "/login")).status, 200);
      assert.deepEqual(legacy.outbound(), [], "legacy mode made no outbound connection");
    } finally {
      legacy.stop();
    }
  });

  test("16. NET-1 and audit totals: no outbound connection; every business's audit stays inside it", async () => {
    assert.deepEqual(app.outbound(), [], "non-local connections attempted by the app");
    const leaks = await db.query<{ n: number }>(
      `select count(*)::int n from public.workspace_audit_log l
       where l.workspace_id = $1 and l.target::text in (select id::text from public.contacts where workspace_id = $2)`, [wsH, wsS]);
    assert.equal(leaks.rows[0].n, 0, "Harbor's audit never references Summit's records");
    const summitAudit = await ok(call(summitOwner.cookie, "GET", "/api/audit?limit=100"), "summit audit");
    assert.equal(summitAudit.text.includes(ids.contact), false, "Summit's audit view shows nothing of Harbor");
    assert.equal(/[0-9a-f]{64}|token_hash|password/i.test(summitAudit.text), false, "no credential material in the audit view");
  });
});

// Staging rehearsal (checklist §1 T4): the acceptance journeys, run by the locally built app against
// the separate hosted staging project with synthetic @example.test people and "(synthetic)"
// businesses. Not part of any local suite; run on purpose only:
//
//   STAGING_REHEARSAL=1 STAGING_PROJECT_REF=<ref> STAGING_APP_URL=http://localhost:3000 \
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… STAGING_DB_URL=… \
//   node --require ./scripts/stub-server-only.cjs --import tsx --test tests/staging/rehearsal.test.ts
//
// The app must already be running at STAGING_APP_URL (loopback only) against the same project.
// Refuses: a non-https or non-*.supabase.co URL, a ref that is not STAGING_PROJECT_REF, the production
// ref, and any project holding a workspace that is not "(synthetic)". It creates only @example.test
// users and never reads or changes any other account. Keys are never printed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { appFetch, cookieHeader, readSessionCookie, rest, totp, type App, type StackEnv } from "../supabase-stack/stack";

const PRODUCTION_REFS = new Set(["rbghfpwbwmrjbpjswbbn"]);
const run = `stg${Date.now().toString(36)}`;
const email = (who: string) => `${who}-${run}@example.test`;
const HARBOR = `Harbor Plumbing ${run} (synthetic)`;
const SUMMIT = `Summit Roofing ${run} (synthetic)`;
const REASON = "Staging rehearsal support check";
const password = (who: string) => `Stg-${who}-${run}-Aa1!`;

type R = Awaited<ReturnType<typeof appFetch>>;
type Person = { email: string; password: string; id?: string; cookie: string };

let env: StackEnv;
let db: pg.Client;
let app: App;
let ref = "";

const admin: Person = { email: email("platform-admin"), password: password("admin"), cookie: "" };
let secret = "";
let lastCode = "";
let wsH = "";
let wsS = "";
let harborToken = "";
let summitToken = "";
const harborOwner: Person = { email: email("harbor-owner"), password: password("harbor-owner"), cookie: "" };
const summitOwner: Person = { email: email("summit-owner"), password: password("summit-owner"), cookie: "" };
const dana: Person = { email: email("harbor-admin"), password: password("harbor-admin"), cookie: "" };
const eli: Person = { email: email("harbor-employee"), password: password("harbor-employee"), cookie: "" };
const casey: Person = { email: email("casey"), password: password("casey"), cookie: "" };
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
  const m = /\/invite\/([0-9a-f]{64})$/.exec(String(url));
  assert.ok(m, "invite link has a token");
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
const login = async (p: Person) => {
  const r = await appFetch(app, "/api/auth/login", { method: "POST", json: { email: p.email, password: p.password } });
  assert.equal(r.status, 200, `login ${p.email}: ${r.status} ${r.text.slice(0, 200)}`);
  return cookieHeader(r.setCookies);
};
const userId = async (address: string) =>
  (await db.query<{ id: string }>("select id from auth.users where email = $1", [address])).rows[0]?.id;
/** A confirmed synthetic account made through the Auth admin API (public sign-up is off on staging). */
const createAccount = async (p: Person, fullName: string) => {
  assert.ok(p.email.endsWith("@example.test"));
  const r = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password, email_confirm: true, user_metadata: { full_name: fullName } }),
  });
  const body = await r.json().catch(() => null);
  assert.equal(r.status, 200, `create ${p.email}: ${r.status} ${JSON.stringify(body?.code ?? body?.error_code ?? null)}`);
  p.id = body.id;
};
const counts = async (ws: string) =>
  (await db.query<Record<string, number>>(
    `select (select count(*)::int from public.contacts where workspace_id = $1) contacts,
            (select count(*)::int from public.opportunities where workspace_id = $1) opportunities,
            (select count(*)::int from public.appointments where workspace_id = $1) appointments,
            (select count(*)::int from public.tasks where workspace_id = $1) tasks,
            (select count(*)::int from public.workspace_members where workspace_id = $1) members`, [ws])).rows[0];
const plain = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("staging rehearsal: two synthetic businesses through the local app against fna-staging", () => {
  before(async () => {
    assert.equal(process.env.STAGING_REHEARSAL, "1", "set STAGING_REHEARSAL=1 to run against staging");
    const url = new URL((process.env.SUPABASE_URL ?? "").trim());
    ref = (process.env.STAGING_PROJECT_REF ?? "").trim();
    assert.equal(url.protocol, "https:", "staging must be https");
    assert.equal(url.hostname, `${ref}.supabase.co`, "SUPABASE_URL must be the STAGING_PROJECT_REF project");
    assert.ok(ref && !PRODUCTION_REFS.has(ref), "refusing the production project");
    const dbUrl = (process.env.STAGING_DB_URL ?? "").trim();
    assert.ok(dbUrl.includes(ref), "STAGING_DB_URL must belong to the same project");
    const appUrl = new URL((process.env.STAGING_APP_URL ?? "").trim());
    assert.ok(["localhost", "127.0.0.1"].includes(appUrl.hostname), "the app must be local");
    env = {
      apiUrl: url.origin, dbUrl, anonKey: (process.env.SUPABASE_ANON_KEY ?? "").trim(),
      serviceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim(), jwtSecret: "",
    };
    assert.ok(env.anonKey && env.serviceRoleKey, "keys are set");
    db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const foreign = await db.query<{ n: number }>("select count(*)::int n from public.workspaces where name not like '%(synthetic)'");
    assert.equal(foreign.rows[0].n, 0, "staging holds a non-synthetic workspace; refusing");
    app = { url: appUrl.origin, stop: () => undefined, outbound: () => [], log: () => "" };
    const health = await appFetch(app, "/api/health");
    assert.deepEqual([health.status, health.body?.authProvider, health.body?.db], [200, "supabase", "ok"], "app health");

    await createAccount(admin, "Staging Platform Admin (synthetic)");
    await db.query("select public.platform_admin_grant($1, $2)", [admin.id, { via: "tests/staging/rehearsal.test.ts", run }]);
  });

  after(async () => {
    if (db && admin.id) {
      await db.query("select public.platform_admin_revoke($1, $2, $3)", [admin.id, "Staging rehearsal finished", { run }]).catch(() => undefined);
    }
    await db?.end().catch(() => undefined);
  });

  test("1. platform admin: password session is refused, MFA enrolment in the app reaches AAL2", async () => {
    admin.cookie = await login(admin);
    expect(await call(admin.cookie, "GET", "/api/platform/workspaces"), 403, "mfa_required", "AAL1 admin");
    const en = await ok(call(admin.cookie, "POST", "/api/auth/mfa/enroll", {}), "enrol");
    secret = en.body.secret;
    const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, "0");
    expect(await call(admin.cookie, "POST", "/api/auth/mfa/verify", { factorId: en.body.factorId, code: wrong }), 422, "validation_failed", "wrong code");
    const v = await ok(call(admin.cookie, "POST", "/api/auth/mfa/verify", { factorId: en.body.factorId, code: await freshCode() }), "verify");
    assert.deepEqual([v.body.aal, v.body.platformActive], ["aal2", true]);
    admin.cookie = mergeCookies(admin.cookie, v.setCookies);
    await ok(call(admin.cookie, "GET", "/api/platform/workspaces"), "console after MFA");
    assert.equal((await appFetch(app, "/platform", { cookie: admin.cookie })).status, 200);
  });

  test("2. provisioning: two businesses, owner links shown once, a repeat is idempotent", async () => {
    const harbor = { provisioningKey: `${run}-harbor`, name: HARBOR, slug: `harbor-${run}`, ownerEmail: harborOwner.email };
    const h = await ok(call(admin.cookie, "POST", "/api/platform/workspaces", harbor), "provision Harbor");
    assert.equal(h.body.created, true);
    wsH = h.body.workspaceId;
    harborToken = tokenOf(h.body.inviteUrl);
    assert.deepEqual((await ok(call(admin.cookie, "POST", "/api/platform/workspaces", harbor), "repeat")).body,
      { ok: true, workspaceId: wsH, created: false, inviteUrl: null });
    const s = await ok(call(admin.cookie, "POST", "/api/platform/workspaces",
      { provisioningKey: `${run}-summit`, name: SUMMIT, slug: `summit-${run}`, ownerEmail: summitOwner.email }), "provision Summit");
    wsS = s.body.workspaceId;
    summitToken = tokenOf(s.body.inviteUrl);
    const list = await ok(call(admin.cookie, "GET", `/api/platform/workspaces?q=${run}&limit=10`), "search");
    assert.deepEqual(list.body.items.map((w: { id: string }) => w.id).sort(), [wsH, wsS].sort());
    const detail = await ok(call(admin.cookie, "GET", `/api/platform/workspaces/${wsH}`), "detail");
    assert.equal(/[0-9a-f]{64}|token_hash|invite_token/.test(detail.text), false, "no invitation token after creation");
    assert.equal((await db.query("select count(*)::int n from public.pipeline_stages where workspace_id = $1", [wsH])).rows[0].n, 12);
  });

  test("3. invitation acceptance with public sign-up off: a new account (Harbor) and an existing account (Summit)", async () => {
    const preview = await appFetch(app, `/api/invitations/${harborToken}`);
    assert.equal(preview.status, 200, preview.text);
    assert.equal(preview.text.includes(harborOwner.email), false, "the preview masks the email");
    const joined = await appFetch(app, `/api/invitations/${harborToken}/accept`, { method: "POST", json: { password: harborOwner.password } });
    assert.equal(joined.status, 200, joined.text.slice(0, 200));
    harborOwner.cookie = cookieHeader(joined.setCookies);
    harborOwner.id = await userId(harborOwner.email);
    const me = await ok(call(harborOwner.cookie, "GET", "/api/auth/me"), "owner me");
    assert.deepEqual([me.body.role, me.body.workspace.id], ["owner", wsH]);
    expect(await appFetch(app, `/api/invitations/${harborToken}/accept`, { method: "POST", json: { password: "Another-pass-123" } }),
      410, "invitation_used", "the link works once");

    await createAccount(summitOwner, "Summit Owner (synthetic)");
    summitOwner.cookie = await login(summitOwner);
    expect(await call(summitOwner.cookie, "GET", "/api/contacts"), 403, "no_active_workspace", "before accepting");
    const noAccess = await appFetch(app, "/dashboard", { cookie: summitOwner.cookie });
    assert.equal(new URL(noAccess.location!, app.url).pathname, "/no-access");
    await ok(appFetch(app, `/api/invitations/${summitToken}/accept`, { method: "POST", cookie: summitOwner.cookie, json: {} }), "accept Summit");
    assert.equal((await ok(call(summitOwner.cookie, "GET", "/api/auth/me"), "summit me")).body.workspace.id, wsS);
  });

  test("4. team: owner invites an admin, an employee, and a member of both businesses; roles apply", async () => {
    for (const [p, role] of [[dana, "admin"], [eli, "employee"]] as const) {
      const inv = await ok(call(harborOwner.cookie, "POST", "/api/team/invitations", { email: p.email, role }), `invite ${role}`);
      const j = await appFetch(app, `/api/invitations/${tokenOf(inv.body.inviteUrl)}/accept`, { method: "POST", json: { password: p.password } });
      assert.equal(j.status, 200, j.text.slice(0, 200));
      p.cookie = cookieHeader(j.setCookies);
      p.id = await userId(p.email);
    }
    await createAccount(casey, "Casey Consultant (synthetic)");
    casey.cookie = await login(casey);
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
    await ok(call(eli.cookie, "POST", `/api/conversations/${ids.conversation}/notes`, { body: "Confirmed Tuesday by phone" }), "inbox note");
    const thread = await ok(call(harborOwner.cookie, "GET", `/api/conversations/${ids.conversation}/messages?limit=10`), "thread");
    assert.equal(thread.body.items.length, 2);
    const summary = await ok(call(harborOwner.cookie, "GET", "/api/dashboard/summary"), "summary");
    assert.deepEqual([summary.body.summary.contactsCount, summary.body.summary.opportunitiesCount, summary.body.summary.appointmentsCount], [1, 1, 1]);
    const activity = await db.query<{ entity_id: string; action: string; actor_id: string }>(
      "select entity_id, action, actor_id from public.activity_events where workspace_id = $1 order by id", [wsH]);
    const by = (entity: string, action: string) => activity.rows.find((a) => a.entity_id === entity && a.action === action)?.actor_id;
    assert.deepEqual([by(ids.contact, "created"), by(ids.opportunity, "won"), by(ids.task, "completed")], [eli.id, dana.id, eli.id]);
    for (const route of ["/dashboard", "/contacts", "/pipeline", "/calendar", "/tasks", "/inbox", "/settings"]) {
      const page = await appFetch(app, route, { cookie: harborOwner.cookie });
      assert.equal(page.status, 200, route);
      assert.ok(page.text.includes('class="sidebar'), `${route} keeps the original sidebar`);
    }
  });

  test("6. permission overrides apply on the next request", async () => {
    const extra = await ok(call(eli.cookie, "POST", "/api/contacts", { firstName: "Temp", lastName: "Lead" }), "temp contact");
    expect(await call(eli.cookie, "DELETE", `/api/contacts/${extra.body.contact.id}`), 403, "forbidden", "employee deletes by default");
    await ok(call(dana.cookie, "PATCH", `/api/team/${eli.id}`, { overrides: { "contacts.delete": true } }), "grant override");
    await ok(call(eli.cookie, "DELETE", `/api/contacts/${extra.body.contact.id}`), "delete with override");
    await ok(call(dana.cookie, "PATCH", `/api/team/${eli.id}`, { overrides: { "contacts.delete": false } }), "deny override");
    expect(await call(eli.cookie, "DELETE", `/api/contacts/${ids.contact}`), 403, "forbidden", "after the override is denied");
  });

  test("7. isolation: workspace switching, foreign ids, and the raw Data API with each user's own JWT", async () => {
    const list = await ok(call(casey.cookie, "GET", "/api/workspaces"), "workspaces");
    assert.deepEqual(list.body.workspaces.map((w: { id: string; role: string }) => `${w.id}:${w.role}`).sort(), [`${wsH}:employee`, `${wsS}:admin`].sort());
    ids.summitContact = (await ok(call(summitOwner.cookie, "POST", "/api/contacts", { firstName: "Sam", lastName: "Shingle" }), "summit contact")).body.contact.id;
    for (const [ws, mine, theirs] of [[wsH, ids.contact, ids.summitContact], [wsS, ids.summitContact, ids.contact]] as const) {
      await ok(call(casey.cookie, "POST", "/api/workspaces/active", { workspaceId: ws }), "switch");
      const contacts = await ok(call(casey.cookie, "GET", "/api/contacts?limit=50"), "contacts");
      assert.deepEqual(contacts.body.items.map((c: { id: string }) => c.id), [mine]);
      expect(await call(casey.cookie, "GET", `/api/contacts/${theirs}`), 404, "not_found", "the other business's contact");
    }
    expect(await call(eli.cookie, "POST", "/api/workspaces/active", { workspaceId: wsS }), 403, "forbidden", "switching into a business you are not in");
    const summitJwt = readSessionCookie(summitOwner.cookie).session.access_token;
    const raw = await rest(env, summitJwt, "GET", `contacts?select=id&workspace_id=eq.${wsH}`);
    assert.equal(raw.status, 200, raw.text.slice(0, 200));
    assert.deepEqual(raw.body, [], "RLS hides Harbor's contacts from Summit's owner at the Data API");
    const forged = await rest(env, summitJwt, "POST", "contacts", { workspace_id: wsH, first_name: "Forged" });
    assert.ok([401, 403].includes(forged.status), `forged insert into Harbor: ${forged.status}`);
    const anon = await rest(env, null, "GET", "contacts?select=id&limit=1");
    assert.ok(anon.status === 401 || (anon.status === 200 && anon.body.length === 0), `anon read: ${anon.status}`);
    for (const table of ["auth_sessions", "sync_contacts", "sync_events"]) {
      const legacy = await rest(env, summitJwt, "GET", `${table}?select=*&limit=1`);
      assert.ok([401, 403, 404].includes(legacy.status), `legacy ${table} is closed: ${legacy.status}`);
    }
  });

  test("8. malformed requests answer a JSON 4xx and write nothing", async () => {
    const before = await counts(wsH);
    const routes: [string, string][] = [
      ["POST", "/api/contacts"], ["PATCH", `/api/contacts/${ids.contact}`], ["POST", "/api/opportunities"], ["POST", "/api/appointments"],
      ["POST", "/api/tasks"], ["PATCH", "/api/settings/workspace"], ["POST", "/api/team/invitations"], ["POST", "/api/auth/login"],
    ];
    const failures: string[] = [];
    for (const [method, path] of routes) {
      for (const [body, contentType] of [["{", "application/json"], ["[]", "application/json"], ["null", "application/json"], ['{"firstName":"X"}', "text/plain"]]) {
        const r = await appFetch(app, path, { method, cookie: harborOwner.cookie, body, contentType });
        if (r.status >= 500 || r.status < 400 || typeof r.body?.code !== "string") failures.push(`${method} ${path} ${body} -> ${r.status}`);
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(await counts(wsH), before);
  });

  test("9. concurrency: duplicate creations settle to one record", async () => {
    const address = `dup-${run}@example.test`;
    const racers = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      call(i % 2 ? eli.cookie : dana.cookie, "POST", "/api/contacts", { firstName: `Dup${i}`, email: address })));
    assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409, 409, 409, 409], racers.map((r) => r.text.slice(0, 80)).join(" | "));
  });

  test("10. pagination: keyset pages over tasks have no overlap", async () => {
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
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, 5);
  });

  test("11. platform support: read grant, write grant attribution, ending and clock expiry", async () => {
    const read = await ok(call(admin.cookie, "POST", `/api/platform/workspaces/${wsH}/access`, { mode: "read", reason: REASON, durationMinutes: 15 }), "read grant");
    const page = await appFetch(app, "/dashboard", { cookie: admin.cookie });
    assert.equal(page.status, 200);
    assert.match(plain(page.text), /Platform support access: .*Read-only.*expires/);
    assert.equal((await ok(call(admin.cookie, "GET", "/api/contacts"), "read")).body.items.some((c: { id: string }) => c.id === ids.contact), true);
    expect(await call(admin.cookie, "POST", "/api/contacts", { firstName: "Nope" }), 403, "forbidden", "read grant writes");
    expect(await call(admin.cookie, "GET", `/api/contacts/${ids.summitContact}`), 404, "not_found", "other workspace during the grant");
    await ok(call(admin.cookie, "DELETE", `/api/platform/access/${read.body.grant.id}`, { reason: "Support session finished" }), "end read grant");
    expect(await call(admin.cookie, "GET", "/api/contacts"), 403, "no_active_workspace", "after ending");
    const write = await ok(call(admin.cookie, "POST", `/api/platform/workspaces/${wsH}/access`, { mode: "write", reason: REASON, durationMinutes: 1 }), "write grant");
    const made = await ok(call(admin.cookie, "POST", "/api/contacts", { firstName: "Support", lastName: "Fix" }), "write under grant");
    const audit = await db.query<{ actor_id: string; actor_kind: string; grant_id: string }>(
      "select actor_id, actor_kind, grant_id from public.workspace_audit_log where workspace_id = $1 and target = $2", [wsH, made.body.contact.id]);
    assert.ok(audit.rows.some((a) => a.actor_id === admin.id && a.actor_kind === "platform_admin" && a.grant_id === write.body.grant.id));
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(write.body.grant.expiresAt) - Date.now()) + 2000));
    expect(await call(admin.cookie, "POST", "/api/contacts", { firstName: "Late" }), 403, "no_active_workspace", "after the clock expiry");
  });

  test("12. suspension blocks members, a dual member keeps the other business, reactivation restores", async () => {
    await ok(call(admin.cookie, "POST", `/api/platform/workspaces/${wsS}/suspend`, { reason: REASON }), "suspend");
    expect(await call(summitOwner.cookie, "GET", "/api/contacts"), 423, "workspace_suspended", "owner read");
    expect(await call(summitOwner.cookie, "POST", "/api/contacts", { firstName: "Blocked" }), 423, "workspace_suspended", "owner write");
    await ok(call(casey.cookie, "POST", "/api/workspaces/active", { workspaceId: wsH }), "dual member switches to Harbor");
    await ok(call(casey.cookie, "GET", "/api/contacts"), "Harbor still works");
    await ok(call(admin.cookie, "POST", `/api/platform/workspaces/${wsS}/reactivate`, { reason: REASON }), "reactivate");
    const back = await ok(call(summitOwner.cookie, "GET", "/api/contacts"), "after reactivation");
    assert.deepEqual(back.body.items.map((c: { id: string }) => c.id), [ids.summitContact]);
  });

  test("13. access removal: a removed employee loses access on the next request", async () => {
    const open = await ok(call(dana.cookie, "POST", "/api/tasks", { title: "Leftover", assignedUserId: eli.id }), "open task");
    await ok(call(dana.cookie, "DELETE", `/api/team/${eli.id}`), "remove employee");
    expect(await call(eli.cookie, "GET", "/api/contacts"), 403, "no_active_workspace", "removed employee's same session");
    const task = (await db.query<{ assigned_user_id: string | null }>("select assigned_user_id from public.tasks where id = $1", [open.body.task.id])).rows[0];
    assert.equal(task.assigned_user_id, null);
  });

  test("14. logout ends the session at once on hosted PostgREST (M21)", async () => {
    const throwaway = await login(dana);
    const { session } = readSessionCookie(throwaway);
    await ok(call(throwaway, "GET", "/api/contacts"), "before logout");
    assert.equal((await call(throwaway, "POST", "/api/auth/logout")).status, 200);
    const read = await call(throwaway, "GET", "/api/contacts");
    const write = await call(throwaway, "POST", "/api/contacts", { firstName: "Replay", lastName: "Check" });
    const sensitive = await call(throwaway, "POST", "/api/team/invitations", { email: email("replay"), role: "employee" });
    expect(read, 401, "unauthenticated", "replayed cookie read");
    expect(write, 401, "unauthenticated", "replayed cookie write");
    expect(sensitive, 401, "unauthenticated", "replayed cookie sensitive action");
    const restRead = await rest(env, session.access_token, "GET", "contacts?select=id&limit=1");
    const restWrite = await rest(env, session.access_token, "POST", "contacts", { workspace_id: wsH, first_name: "Replay" });
    assert.deepEqual([restRead.status, restWrite.status], [401, 401], restRead.text.slice(0, 200));
    const refresh = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { apikey: env.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    assert.notEqual(refresh.status, 200, "revoked refresh token");
    await refresh.body?.cancel();
    assert.equal((await db.query("select 1 from public.contacts where first_name = 'Replay'")).rowCount, 0);
    await ok(call(dana.cookie, "GET", "/api/contacts"), "other session continues");
  });

  test("15. audit stays inside each business; non-synthetic accounts were not touched", async () => {
    const leaks = await db.query<{ n: number }>(
      `select count(*)::int n from public.workspace_audit_log l
       where l.workspace_id = $1 and l.target::text in (select id::text from public.contacts where workspace_id = $2)`, [wsH, wsS]);
    assert.equal(leaks.rows[0].n, 0);
    const summitAudit = await ok(call(summitOwner.cookie, "GET", "/api/audit?limit=100"), "summit audit");
    assert.equal(summitAudit.text.includes(ids.contact), false);
    assert.equal(/[0-9a-f]{64}|token_hash|password/i.test(summitAudit.text), false);
    const outsiders = await db.query<{ n: number }>(
      `select count(*)::int n from public.workspace_members m join auth.users u on u.id = m.user_id where u.email not like '%@example.test'`);
    assert.equal(outsiders.rows[0].n, 0, "no real account was added to a synthetic business");
  });
});

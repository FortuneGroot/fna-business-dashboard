// Backup and restore rehearsal (hardening packet 5) on two disposable stacks. Stack A holds two
// populated synthetic businesses; its data is exported with credentials scrubbed, then restored into
// stack B, a separate freshly migrated stack on other ports. Stack A is only read during export.
// Restored users get new passwords on B (passwords, sessions and MFA are deliberately not exported),
// and every functional check on B uses those users' own sessions.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { digest, EXCLUDED_TABLES, exportStack, readTable, restoreStack, type Manifest } from "../supabase-stack/backup";
import {
  adminDb, appLogin, newPassword, rest, rpc, signUp, startApp, startStack, storage, upgradeToAal2,
  type App, type Identity, type Stack,
} from "../supabase-stack/stack";

const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;
const HARBOR = "Harbor Physio (synthetic)";
const RIDGE = "Ridge Landscaping (synthetic)";
const B_OFFSET = 2000;

type Res = { status: number; body: any; text: string };
const call = (app: App, cookie: string, method: string, path: string, json?: unknown): Promise<Res> =>
  fetch(`${app.url}${path}`, {
    method,
    headers: { cookie, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
    redirect: "manual",
  }).then(async (res) => {
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, text };
  });
const ok = async (p: Promise<Res>, label: string) => {
  const r = await p;
  assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 300)}`);
  return r;
};

type Business = {
  name: string;
  ws: string;
  owner: Identity;
  cookie: string;
  contacts: string[];
  stages: Record<string, string>;
  opportunities: Record<string, string>;
  calendar: string;
  appointments: string[];
  logo: string;
  logoText: string;
};

let A: Stack;
let B: Stack | undefined;
let dbA: pg.Client;
let dbB: pg.Client | undefined;
let appA: App;
let appB: App | undefined;
let dir = "";
let manifest: Manifest;
let employee: Identity;
let pendingInviteToken = "";
const businesses: Business[] = [];
const fingerprint = new Map<string, string>();
const auditCounts = new Map<string, number>();

async function fingerprintOf(db: pg.Client, tables: string[]) {
  const out = new Map<string, string>();
  for (const t of tables) out.set(t, digest(await readTable(db, t)));
  return out;
}

async function populate(platformAal2: string, name: string, key: string, tz: string, contacts: string[]): Promise<Business> {
  const owner = await signUp(A.env, email(`${key}-owner`), `${key[0].toUpperCase()}${key.slice(1)} Owner (synthetic)`);
  const prov = await rpc(A.env, platformAal2, "platform_provision_workspace", {
    p_provisioning_key: `synthetic-${key}-${run}`, p_name: name, p_slug: `${key}-${run}`, p_owner_email: owner.email,
  });
  assert.equal(prov.status, 200, prov.text);
  assert.equal((await rpc(A.env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
  const ws = prov.body.workspace_id as string;
  const cookie = await appLogin(appA, owner);
  const c = (method: string, path: string, json?: unknown) => call(appA, cookie, method, path, json);

  await ok(c("PATCH", "/api/settings/workspace", {
    timezone: tz, industry: key === "harbor" ? "Physiotherapy" : "Landscaping", businessPhone: "617-555-0100",
    supportEmail: `help-${key}-${run}@example.test`, websiteUrl: `https://${key}.example.test`,
  }), `${key} settings`);
  await ok(c("PUT", "/api/settings/ai-receptionist", {
    enabled: false, greeting: `Thanks for calling ${name}.`, businessHoursMode: "business_hours", escalationUserId: owner.id,
    faq: [{ question: "Do you take walk-ins?", answer: "Bookings only." }], voice: "alloy",
  }), `${key} receptionist`);

  const ids: string[] = [];
  for (const [i, full] of contacts.entries()) {
    const [firstName, lastName] = full.split(" ");
    const r = await ok(c("POST", "/api/contacts", {
      firstName, lastName, email: `${firstName.toLowerCase()}-${key}-${run}@example.test`, tags: i % 2 ? ["returning"] : ["new", key],
    }), `${key} contact ${full}`);
    ids.push(r.body.contact.id);
  }
  await ok(c("POST", `/api/contacts/${ids[0]}/notes`, { body: `First visit notes for ${contacts[0]}` }), `${key} contact note`);

  const pipeline = async () => {
    const out: Record<string, string> = {};
    for (const s of (await ok(c("GET", "/api/pipeline"), `${key} pipeline`)).body.pipeline.stages) out[s.name] = s.id;
    return out;
  };
  const [firstStage, firstId] = Object.entries(await pipeline())[0];
  await ok(c("PATCH", `/api/pipeline/stages/${firstId}`, { name: `${firstStage} (${key})` }), `${key} rename stage`);
  const stages = await pipeline();
  const opportunities: Record<string, string> = {};
  for (const [i, title] of ["Annual plan", "Spring cleanup", "Referral"].entries()) {
    const stageId = Object.values(stages)[0];
    const r = await ok(c("POST", "/api/opportunities", { contactId: ids[i], stageId, title: `${title} (${key})`, valueCents: 10000 * (i + 1) }), `${key} opportunity`);
    opportunities[title] = r.body.opportunity.id;
  }
  await ok(c("POST", `/api/opportunities/${opportunities["Annual plan"]}/move`, { stageId: stages["Won"] }), `${key} won`);
  await ok(c("POST", `/api/opportunities/${opportunities["Spring cleanup"]}/move`, { stageId: Object.values(stages)[1] }), `${key} moved`);

  const cal = await ok(c("POST", "/api/calendars", { name: `${key} visits`, slug: `${key}-visits`, timezone: tz, durationMinutes: 60 }), `${key} calendar`);
  const calendar = cal.body.calendar.id as string;
  await ok(c("PUT", `/api/calendars/${calendar}/availability`, { rules: [{ weekday: 1, start: "09:00", end: "17:00" }, { weekday: 3, start: "10:00", end: "14:00" }] }), `${key} hours`);
  const appointments: string[] = [];
  for (const [i, day] of ["2031-03-03", "2031-03-05", "2031-03-10"].entries()) {
    const r = await ok(c("POST", "/api/appointments", {
      calendarId: calendar, contactId: ids[i], startsAt: `${day}T15:00:00Z`, endsAt: `${day}T16:00:00Z`,
    }), `${key} appointment`);
    appointments.push(r.body.appointment.id);
  }
  await ok(c("PATCH", `/api/appointments/${appointments[2]}`, { status: "cancelled" }), `${key} cancel`);
  await ok(c("POST", "/api/tasks", { title: `Call ${contacts[1]} back (${key})`, dueAt: "2031-03-04T14:00:00Z" }), `${key} task`);

  const conv = (await dbA.query<{ id: string }>(
    "insert into public.conversations (workspace_id, contact_id, channel, status) values ($1, $2, 'sms', 'open') returning id", [ws, ids[0]])).rows[0].id;
  await dbA.query("insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status) values ($1, $2, 'inbound', $3, 'delivered')",
    [ws, conv, `Can I move my ${key} visit?`]);
  await dbA.query("insert into public.reviews (workspace_id, contact_id, rating, source) values ($1, $2, 5, 'manual')", [ws, ids[1]]);
  await ok(c("POST", `/api/conversations/${conv}/notes`, { body: "Offered Wednesday instead" }), `${key} inbox note`);

  const logo = `${ws}/logo-${run}.txt`;
  const logoText = `${name} synthetic logo ${run}`;
  const up = await storage(A.env, owner.token, "POST", `workspace-assets/${logo}`, logoText);
  assert.equal(up.status, 200, up.text);
  return { name, ws, owner, cookie, contacts: ids, stages, opportunities, calendar, appointments, logo, logoText };
}

function walk(root: string): string[] {
  return readdirSync(root).flatMap((n) => {
    const p = join(root, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Password grant against a stack's own GoTrue (B's users get B-only passwords). */
async function signIn(apiUrl: string, anonKey: string, user: { email: string; password: string }) {
  const r = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: anonKey, "content-type": "application/json" }, body: JSON.stringify(user),
  });
  const body: any = await r.json();
  assert.equal(r.status, 200, `sign-in for ${user.email}: ${r.status}`);
  return body.access_token as string;
}

describe("backup and restore rehearsal: two synthetic businesses into a fresh disposable stack", () => {
  before(async () => {
    A = startStack();
    dbA = await adminDb(A.env);
    appA = await startApp(A.env);
    const platform = await signUp(A.env, email("platform"), "Restore Platform Admin");
    await dbA.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
    const platformAal2 = await upgradeToAal2(A.env, platform);
    businesses.push(await populate(platformAal2, HARBOR, "harbor", "America/New_York", ["Hana Hughes", "Hugo Hale", "Holly Hart", "Henry Hill"]));
    businesses.push(await populate(platformAal2, RIDGE, "ridge", "America/Denver", ["Rosa Reyes", "Reed Ross", "Ruby Rand"]));
    const harbor = businesses[0];
    const inv = await ok(call(appA, harbor.cookie, "POST", "/api/team/invitations", { email: email("employee"), role: "employee" }), "invite employee");
    employee = await signUp(A.env, email("employee"), "Ellis Employee (synthetic)");
    assert.equal((await rpc(A.env, employee.token, "accept_invitation", { p_token: String(inv.body.inviteUrl).split("/invite/")[1] })).status, 200);
    await ok(call(appA, harbor.cookie, "PATCH", `/api/team/${employee.id}`, { overrides: { "contacts.delete": true } }), "employee override");
    const pending = await ok(call(appA, businesses[1].cookie, "POST", "/api/team/invitations", { email: email("pending"), role: "admin" }), "pending invite");
    pendingInviteToken = String(pending.body.inviteUrl).split("/invite/")[1];
    for (const b of businesses) {
      auditCounts.set(b.ws, (await ok(call(appA, b.cookie, "GET", "/api/audit?limit=100"), "audit A")).body.items.length);
    }
  });

  after(async () => {
    appA?.stop();
    appB?.stop();
    await dbA?.end().catch(() => undefined);
    await dbB?.end().catch(() => undefined);
    A?.stop();
    B?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("export: complete, leaves the source untouched, and retains no credentials or session material", async () => {
    dir = mkdtempSync(join(tmpdir(), "fna-backup-"));
    manifest = await exportStack(A, dbA, dir);
    const tables = manifest.tables.map((t) => t.table);
    for (const t of EXCLUDED_TABLES) assert.ok(!tables.includes(t), `${t} is not exported`);
    for (const t of ["auth.users", "public.workspaces", "public.contacts", "public.opportunities", "public.pipeline_stages",
      "public.appointments", "public.calendars", "public.workspace_audit_log", "storage.objects"]) {
      assert.ok(manifest.tables.find((m) => m.table === t)?.rows, `${t} has rows`);
    }
    assert.equal(manifest.storageObjects.length, 2, "both logos copied");
    for (const b of businesses) {
      const file = manifest.storageObjects.find((o) => o.name === b.logo);
      assert.ok(file, `${b.logo} exported`);
    }
    fingerprint.clear();
    for (const [t, d] of await fingerprintOf(dbA, tables)) fingerprint.set(t, d);
    for (const m of manifest.tables) assert.equal(fingerprint.get(m.table), m.sha256, `${m.table} unchanged by the export`);

    const users = JSON.parse(readFileSync(join(dir, "tables", "auth.users.json"), "utf8")).rows as Record<string, unknown>[];
    assert.equal(users.length, 4, "platform admin, two owners, one employee");
    for (const u of users) assert.equal(u.encrypted_password, null, "password hashes are not exported");
    const people = [...businesses.map((b) => b.owner), employee];
    const forbidden: [string, RegExp | string][] = [
      ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./], ["bcrypt hash", /\$2[aby]\$\d\d\$/],
      ["service key", A.env.serviceRoleKey], ["anon key", A.env.anonKey], ["JWT secret", A.env.jwtSecret],
      ["pending invitation token", pendingInviteToken], ["refresh token field", /"refresh_token"\s*:/],
      ...people.flatMap((p) => [[`password of ${p.email}`, p.password], [`access token of ${p.email}`, p.token]] as [string, string][]),
    ];
    const files = walk(dir);
    assert.ok(files.length > manifest.tables.length);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const [what, pattern] of forbidden) {
        const found = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
        assert.ok(!found, `${what} must not appear in ${f.slice(dir.length)}`);
      }
    }
  });

  test("restore into a fresh disposable stack reproduces every exported row, sequence, and file", async () => {
    assert.ok(manifest, "export ran");
    B = startStack(B_OFFSET);
    assert.notEqual(B.env.apiUrl, A.env.apiUrl);
    dbB = await adminDb(B.env);
    assert.equal((await dbB.query("select count(*)::int n from auth.users")).rows[0].n, 0, "B starts empty");
    const migrationsB = (await dbB.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by 1")).rows.map((r) => r.version);
    assert.deepEqual(migrationsB, manifest.migrations, "B runs the same schema version");

    restoreStack(B, dir);

    const restored = await fingerprintOf(dbB, manifest.tables.map((t) => t.table));
    const differing = manifest.tables.filter((m) => restored.get(m.table) !== m.sha256).map((m) => m.table);
    assert.deepEqual(differing, [], "every exported table matches row for row");
    for (const s of manifest.sequences) {
      const v: string | null | undefined = (await dbB.query<{ v: string | null }>("select last_value::text v from pg_sequences where schemaname || '.' || sequencename = $1", [s.sequence])).rows[0]?.v;
      assert.equal(v ?? null, s.lastValue, `sequence ${s.sequence}`);
    }
    assert.equal((await dbB.query("select count(*)::int n from auth.sessions")).rows[0].n, 0, "no sessions restored");
    assert.equal((await dbB.query("select count(*)::int n from auth.mfa_factors")).rows[0].n, 0, "no MFA secrets restored");
    assert.equal((await dbB.query("select count(*)::int n from public.integration_secrets")).rows[0].n, 0, "integration secrets are re-entered, not restored");
    // The source is untouched by the whole rehearsal.
    const after = await fingerprintOf(dbA, manifest.tables.map((t) => t.table));
    for (const m of manifest.tables) assert.equal(after.get(m.table), m.sha256, `${m.table} on A unchanged`);
  });

  test("restored businesses work for their own users: separation, settings, stage IDs, appointments, audit, files", async () => {
    assert.ok(B && dbB, "restore ran");
    appB = await startApp(B.env, { build: false });
    const people = [...businesses.map((b) => b.owner), employee];
    const passwordOnA = employee.password;
    for (const p of people) {
      const pw = newPassword();
      const r: Response = await fetch(`${B.env.apiUrl}/auth/v1/admin/users/${p.id}`, {
        method: "PUT",
        headers: { apikey: B.env.serviceRoleKey, Authorization: `Bearer ${B.env.serviceRoleKey}`, "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      assert.equal(r.status, 200, `set a new password on B for ${p.email}`);
      p.password = pw;
    }
    // The pre-restore passwords no longer exist anywhere: an A password does not sign in on B.
    const stale = await fetch(`${B.env.apiUrl}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: B.env.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email: employee.email, password: passwordOnA }),
    });
    assert.equal(stale.status, 400);

    for (const b of businesses) {
      const other = businesses.find((x) => x !== b)!;
      const cookie = await appLogin(appB, b.owner);
      const c = (method: string, path: string, json?: unknown) => call(appB!, cookie, method, path, json);
      const me = await ok(c("GET", "/api/auth/me"), `${b.name} me`);
      assert.equal(me.body.workspace.id, b.ws);
      assert.deepEqual((await ok(c("GET", "/api/workspaces"), "workspaces")).body.workspaces.map((w: { id: string }) => w.id), [b.ws],
        "only their own business");

      const contacts = (await ok(c("GET", "/api/contacts?limit=50"), "contacts")).body.items as { id: string }[];
      assert.deepEqual(contacts.map((x) => x.id).sort(), [...b.contacts].sort(), `${b.name} contacts`);
      for (const id of other.contacts) assert.equal((await c("GET", `/api/contacts/${id}`)).status, 404, "other business's contact is invisible");
      const token = await signIn(B.env.apiUrl, B.env.anonKey, b.owner);
      const leak = await rest(B.env, token, "GET", `contacts?select=id&workspace_id=eq.${other.ws}`);
      assert.deepEqual([leak.status, leak.body], [200, []], "row-level security still separates the businesses");

      const settings = (await ok(c("GET", "/api/settings/workspace"), "settings")).body.settings;
      assert.equal(settings.supportEmail, `help-${b.name.startsWith("Harbor") ? "harbor" : "ridge"}-${run}@example.test`);
      assert.equal(settings.timezone, b.name.startsWith("Harbor") ? "America/New_York" : "America/Denver");
      const ai = (await ok(c("GET", "/api/settings/ai-receptionist"), "receptionist")).body;
      assert.match(JSON.stringify(ai), new RegExp(`Thanks for calling ${b.name.replace(/[()]/g, "\\$&")}`));

      const stages = (await ok(c("GET", "/api/pipeline"), "pipeline")).body.pipeline.stages as { id: string; name: string }[];
      assert.deepEqual(Object.fromEntries(stages.map((s) => [s.name, s.id])), b.stages, "stage IDs and names survive");
      const won = (await ok(c("GET", `/api/opportunities/${b.opportunities["Annual plan"]}`), "won opp")).body.opportunity;
      assert.deepEqual([won.stageId, won.status], [b.stages["Won"], "won"]);
      const moved = (await ok(c("GET", `/api/opportunities/${b.opportunities["Spring cleanup"]}`), "moved opp")).body.opportunity;
      assert.equal(moved.stageId, Object.values(b.stages)[1]);

      const appts = (await ok(c("GET", `/api/appointments?calendarId=${b.calendar}&from=2031-03-01T00:00:00Z&to=2031-03-31T00:00:00Z`), "appointments")).body.items as
        { id: string; calendarId: string; status: string; startsAt: string }[];
      assert.deepEqual(appts.map((a) => a.id).sort(), [...b.appointments].sort(), "each appointment once, on its calendar");
      for (const a of appts) assert.equal(a.calendarId, b.calendar);
      assert.equal(appts.find((a) => a.id === b.appointments[2])?.status, "cancelled");
      assert.equal(new Date(appts.find((a) => a.id === b.appointments[0])!.startsAt).toISOString(), "2031-03-03T15:00:00.000Z");
      // Exclusion still applies after restore: the restored booking blocks an overlapping one, the cancelled one does not.
      const clash = await c("POST", "/api/appointments", { calendarId: b.calendar, contactId: b.contacts[3] ?? b.contacts[0], startsAt: "2031-03-03T15:30:00Z", endsAt: "2031-03-03T16:30:00Z" });
      assert.deepEqual([clash.status, clash.body?.code], [409, "overlap"]);
      await ok(c("POST", "/api/appointments", { calendarId: b.calendar, contactId: b.contacts[0], startsAt: "2031-03-10T15:00:00Z", endsAt: "2031-03-10T16:00:00Z" }), "rebook cancelled slot");

      const audit = (await ok(c("GET", "/api/audit?limit=100"), "audit")).body.items as { action: string }[];
      assert.ok(audit.length >= auditCounts.get(b.ws)!, `${b.name} audit history restored`);
      const logo = await storage(B.env, token, "GET", `workspace-assets/${b.logo}`);
      assert.deepEqual([logo.status, logo.text], [200, b.logoText], "logo file restored byte for byte");
      assert.notEqual((await storage(B.env, token, "GET", `workspace-assets/${other.logo}`)).status, 200, "other business's file stays private");
      // New writes on B continue past restored sequence values instead of colliding.
      await ok(c("POST", "/api/contacts", { firstName: "After", lastName: "Restore" }), "new contact after restore");
    }

    const ownerCookie = await appLogin(appB, businesses[0].owner);
    const team = (await ok(call(appB, ownerCookie, "GET", "/api/team"), "team")).body;
    assert.ok(JSON.stringify(team).includes(employee.id), "the employee is still on the Harbor team");
    const empCookie = await appLogin(appB, employee);
    const temp = await ok(call(appB, empCookie, "POST", "/api/contacts", { firstName: "Temp", lastName: "Lead" }), "employee contact");
    await ok(call(appB, empCookie, "DELETE", `/api/contacts/${temp.body.contact.id}`), "restored override still allows delete");
  });
});

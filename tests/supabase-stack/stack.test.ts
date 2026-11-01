// End-to-end checks against a disposable local Supabase stack. Every isolation assertion uses a real
// GoTrue identity and its own JWT through PostgREST or Storage. The superuser connection is used only
// for setup that stands in for the platform-admin bootstrap script and for verifying outcomes.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type pg from "pg";
import {
  adminDb, appFetch, appLogin, capturedMailCount, cookieHeader, jwtPayload, launchBrowser, messageRoutes, readSessionCookie, rest, rpc,
  serviceRest, sessionCookie, signJwt, signUp, startApp, startStack, storage, totp, upgradeToAal2, upgradeToAal2Session,
  type App, type HttpResult, type Identity, type Stack, type StackEnv,
} from "./stack";
import { DASHBOARD_ENDPOINTS, dashboardShapeErrors } from "../helpers/api-shapes";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");
const LEGACY_TABLES = [
  "auth_sessions", "sync_contacts", "sync_contact_tags", "sync_opportunities", "sync_appointments",
  "sync_conversation_events", "sync_tasks", "sync_review_events", "sync_events", "sync_idempotency",
];
const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;

let stack: Stack;
let env: StackEnv;
let db: pg.Client;
let platform: Identity;
let platformAal2 = "";
let ownerA: Identity;
let ownerB: Identity;
let employeeA: Identity;
let outsider: Identity;
let wsA = "";
let wsB = "";
let contactA = "";
let contactB = "";

const denied = (status: number) => status === 401 || status === 403;

async function contacts(token: string) {
  const r = await rest(env, token, "GET", "contacts?select=id,workspace_id,first_name,created_by");
  assert.equal(r.status, 200, r.text);
  return r.body as { id: string; workspace_id: string; first_name: string; created_by: string }[];
}

/** PostgREST answers a successful call to a function returning void with 204 No Content. */
function assertVoidOk(r: HttpResult, what: string) {
  assert.equal(r.status, 204, `${what}: ${r.status} ${r.text}`);
}

async function voidRpc(token: string, fn: string, args: Record<string, unknown>) {
  const r = await rpc(env, token, fn, args);
  assertVoidOk(r, fn);
}

// Every grant issued by a test is tracked and revoked in afterEach, even when an assertion fails,
// so no grant leaks into later tests.
const liveGrants = new Set<string>();

async function grantAccess(ws: string, mode: "read" | "write", reason: string, minutes = 15) {
  const r = await rpc(env, platformAal2, "platform_grant_access", {
    p_workspace_id: ws, p_mode: mode, p_reason: reason, p_minutes: minutes,
  });
  if (r.status === 200) liveGrants.add(r.body.id);
  return r;
}

async function revokeGrant(id: string) {
  liveGrants.delete(id);
  await voidRpc(platformAal2, "platform_revoke_access", { p_grant_id: id, p_reason: "Support session finished" });
}

/** Grants still live for the platform admin, from the database (verification only). */
async function activeGrants(ws?: string): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `select id from public.platform_access_grants
     where admin_user_id = $1 and revoked_at is null and expires_at > now() and ($2::uuid is null or workspace_id = $2)`,
    [platform.id, ws ?? null]);
  return r.rows.map((x) => x.id);
}

describe("real local Supabase stack (CLI migrations, GoTrue, PostgREST, Storage)", () => {
  before(async () => {
    stack = startStack();
    env = stack.env;
    db = await adminDb(env);
  });

  afterEach(async () => {
    for (const id of [...liveGrants]) {
      liveGrants.delete(id);
      const r = await rpc(env, platformAal2, "platform_revoke_access", { p_grant_id: id, p_reason: "Support session finished" });
      if (r.status !== 204 && !/not_found/.test(r.text)) console.error(`cleanup: revoking grant failed: ${r.status} ${r.text}`);
    }
  });

  after(async () => {
    await db?.end();
    stack?.stop();
  });

  test("the Supabase CLI applied every repository migration", async () => {
    const local = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, 14)).sort();
    const applied = (await db.query<{ version: string }>(
      "select version from supabase_migrations.schema_migrations order by version"
    )).rows.map((r) => r.version);
    assert.deepEqual(applied, local);
  });

  test("GoTrue sign-up creates a profile visible only to its owner", async () => {
    platform = await signUp(env, email("platform"), "Platform Admin");
    ownerA = await signUp(env, email("owner-a"), "Owner A");
    ownerB = await signUp(env, email("owner-b"), "Owner B");
    employeeA = await signUp(env, email("employee-a"), "Employee A");
    outsider = await signUp(env, email("outsider"), "Outsider");

    const own = await rest(env, ownerA.token, "GET", "profiles?select=user_id,full_name");
    assert.equal(own.status, 200, own.text);
    assert.deepEqual(own.body, [{ user_id: ownerA.id, full_name: "Owner A" }]);
    const count = await db.query("select count(*)::int as n from public.profiles where user_id = any($1)", [
      [platform.id, ownerA.id, ownerB.id, employeeA.id, outsider.id],
    ]);
    assert.equal(count.rows[0].n, 5);
    const anon = await rest(env, null, "GET", "profiles?select=user_id");
    assert.ok(denied(anon.status) || (anon.status === 200 && anon.body.length === 0), anon.text);
  });

  test("PostgREST rejects forged, expired, and unsigned JWTs", async () => {
    const [h, p] = ownerA.token.split(".");
    const forged = `${h}.${p}.${Buffer.from("not-the-signature").toString("base64url")}`;
    assert.equal((await rest(env, forged, "GET", "profiles?select=user_id")).status, 401);

    const claims = jwtPayload(ownerA.token);
    const expired = signJwt(env.jwtSecret, { ...claims, iat: 1_700_000_000, exp: 1_700_000_600 });
    assert.equal((await rest(env, expired, "GET", "profiles?select=user_id")).status, 401);

    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.`;
    assert.equal((await rest(env, none, "GET", "profiles?select=user_id")).status, 401);

    const wrongKey = signJwt("x".repeat(40), { ...claims, aal: "aal2" });
    assert.equal((await rest(env, wrongKey, "GET", "profiles?select=user_id")).status, 401);
  });

  test("platform RPCs refuse an AAL1 session and accept a verified TOTP (AAL2) session", async () => {
    // Stands in for scripts/bootstrap-platform-admin: the only privileged setup step.
    await db.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);

    const aal1 = await rpc(env, platform.token, "platform_list_workspaces");
    assert.ok(denied(aal1.status), `AAL1 platform call returned ${aal1.status}`);

    platformAal2 = await upgradeToAal2(env, platform);
    assert.equal(jwtPayload(platformAal2).aal, "aal2");
    const ok = await rpc(env, platformAal2, "platform_list_workspaces");
    assert.equal(ok.status, 200, ok.text);

    const notAdmin = await upgradeToAal2(env, outsider);
    const refused = await rpc(env, notAdmin, "platform_list_workspaces");
    assert.ok(denied(refused.status), `non-admin AAL2 call returned ${refused.status}`);
  });

  test("provisioning and invitation acceptance run with each user's own JWT", async () => {
    const provA = await rpc(env, platformAal2, "platform_provision_workspace", {
      p_provisioning_key: `synthetic-tj-towing-${run}`, p_name: "TJ Towing (synthetic)",
      p_slug: `tj-towing-synthetic-${run}`, p_owner_email: ownerA.email,
    });
    assert.equal(provA.status, 200, provA.text);
    const provB = await rpc(env, platformAal2, "platform_provision_workspace", {
      p_provisioning_key: `synthetic-vinny-moving-${run}`, p_name: "Vinny Moving (synthetic)",
      p_slug: `vinny-moving-synthetic-${run}`, p_owner_email: ownerB.email,
    });
    assert.equal(provB.status, 200, provB.text);
    wsA = provA.body.workspace_id;
    wsB = provB.body.workspace_id;

    const wrongUser = await rpc(env, ownerB.token, "accept_invitation", { p_token: provA.body.invite_token });
    assert.notEqual(wrongUser.status, 200, "invitation accepted by the wrong identity");
    assert.equal((await rpc(env, ownerA.token, "accept_invitation", { p_token: provA.body.invite_token })).status, 200);
    assert.equal((await rpc(env, ownerB.token, "accept_invitation", { p_token: provB.body.invite_token })).status, 200);

    const stages = await rest(env, ownerA.token, "GET", "pipeline_stages?select=id");
    assert.equal(stages.status, 200, stages.text);
    assert.equal(stages.body.length, 12);
  });

  test("RLS isolates workspaces over PostgREST and stamps the creator", async () => {
    const insA = await rest(env, ownerA.token, "POST", "contacts", { workspace_id: wsA, first_name: "Alpha" });
    assert.equal(insA.status, 201, insA.text);
    contactA = insA.body[0].id;
    assert.equal(insA.body[0].created_by, ownerA.id);
    const insB = await rest(env, ownerB.token, "POST", "contacts", { workspace_id: wsB, first_name: "Bravo" });
    assert.equal(insB.status, 201, insB.text);
    contactB = insB.body[0].id;

    assert.deepEqual((await contacts(ownerA.token)).map((c) => c.id), [contactA]);
    assert.deepEqual((await contacts(ownerB.token)).map((c) => c.id), [contactB]);
    assert.deepEqual(await contacts(outsider.token), []);

    const cross = await rest(env, ownerB.token, "POST", "contacts", { workspace_id: wsA, first_name: "Intruder" });
    assert.ok(denied(cross.status), `cross-workspace insert returned ${cross.status}`);
    const crossUpdate = await rest(env, ownerB.token, "PATCH", `contacts?id=eq.${contactA}`, { first_name: "Hijacked" });
    assert.equal(crossUpdate.status, 200, crossUpdate.text);
    assert.deepEqual(crossUpdate.body, []);
    const anon = await rest(env, null, "GET", "contacts?select=id");
    assert.ok(denied(anon.status), `anon contacts read returned ${anon.status}`);
  });

  test("forged actor attribution is rejected", async () => {
    const forged = await rest(env, ownerA.token, "POST", "contacts", {
      workspace_id: wsA, first_name: "Forged", created_by: ownerB.id,
    });
    assert.ok(denied(forged.status), `forged created_by returned ${forged.status}`);
    assert.equal(forged.body?.code, "42501");
  });

  test("Storage policies confine objects to the active workspace folder", async () => {
    const objA = `workspace-assets/${wsA}/logo-${run}.txt`;
    const up = await storage(env, ownerA.token, "POST", objA, "workspace A asset");
    assert.equal(up.status, 200, up.text);
    const down = await storage(env, ownerA.token, "GET", objA);
    assert.equal(down.status, 200, down.text);
    assert.equal(down.text, "workspace A asset");

    const otherRead = await storage(env, ownerB.token, "GET", objA);
    assert.notEqual(otherRead.status, 200, "workspace B read workspace A's object");
    const otherWrite = await storage(env, ownerB.token, "POST", `workspace-assets/${wsA}/evil-${run}.txt`, "x");
    assert.notEqual(otherWrite.status, 200, "workspace B wrote into workspace A's folder");
    const anonRead = await storage(env, null, "GET", objA);
    assert.notEqual(anonRead.status, 200, "anonymous read of a private object");
    const ownB = await storage(env, ownerB.token, "POST", `workspace-assets/${wsB}/logo-${run}.txt`, "workspace B asset");
    assert.equal(ownB.status, 200, ownB.text);

    const stored = await db.query(
      "select name from storage.objects where bucket_id = 'workspace-assets' and name like $1", [`%-${run}.txt`]
    );
    assert.deepEqual(stored.rows.map((r) => r.name).sort(), [`${wsA}/logo-${run}.txt`, `${wsB}/logo-${run}.txt`].sort());
  });

  test("a removed member loses access immediately", async () => {
    const inv = await rpc(env, ownerA.token, "create_invitation", { p_email: employeeA.email, p_role: "employee", p_ttl_hours: 72 });
    assert.equal(inv.status, 200, inv.text);
    assert.equal((await rpc(env, employeeA.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
    assert.deepEqual((await contacts(employeeA.token)).map((c) => c.id), [contactA]);
    const logoA = `workspace-assets/${wsA}/logo-${run}.txt`;
    assert.equal((await storage(env, employeeA.token, "GET", logoA)).status, 200);

    await voidRpc(ownerA.token, "remove_member", { p_user_id: employeeA.id });
    assert.deepEqual(await contacts(employeeA.token), []);
    const write = await rest(env, employeeA.token, "POST", "contacts", { workspace_id: wsA, first_name: "After removal" });
    assert.ok(denied(write.status), `removed member insert returned ${write.status}`);
    assert.notEqual((await storage(env, employeeA.token, "GET", logoA)).status, 200, "removed member still reads assets");
  });

  test("platform access requires an explicit, attributed grant", async () => {
    assert.equal((await contacts(platformAal2)).filter((c) => c.workspace_id === wsA).length, 0);

    const read = await grantAccess(wsA, "read", "stack test read access");
    assert.equal(read.status, 200, read.text);
    assert.deepEqual((await contacts(platformAal2)).map((c) => c.id), [contactA]);
    const readWrite = await rest(env, platformAal2, "POST", "contacts", { workspace_id: wsA, first_name: "Read grant" });
    assert.ok(denied(readWrite.status), `read grant insert returned ${readWrite.status}`);

    const write = await grantAccess(wsA, "write", "stack test write access");
    assert.equal(write.status, 200, write.text);
    const ins = await rest(env, platformAal2, "POST", "contacts", { workspace_id: wsA, first_name: "Write grant" });
    assert.equal(ins.status, 201, ins.text);
    assert.equal(ins.body[0].created_by, platform.id);
    const audit = await db.query(
      `select actor_id, actor_kind, action, target from public.workspace_audit_log
       where workspace_id = $1 and grant_id = $2 and action <> 'platform.access_granted' order by id`,
      [wsA, write.body.id]
    );
    assert.deepEqual(audit.rows, [{ actor_id: platform.id, actor_kind: "platform_admin", action: "contacts.insert", target: ins.body[0].id }]);

    for (const g of [read.body.id, write.body.id]) await revokeGrant(g);
    assert.deepEqual(await contacts(platformAal2), []);
  });

  test("a platform write grant can read Storage objects but cannot upload or delete them through the Storage API", async () => {
    const logo = `workspace-assets/${wsA}/logo-${run}.txt`;
    const grant = await grantAccess(wsA, "write", "stack test storage write grant");
    assert.equal(grant.status, 200, grant.text);
    const read = await storage(env, platformAal2, "GET", logo);
    assert.equal(read.status, 200, read.text);
    const objectPath = `${wsA}/granted-${run}.txt`;
    assert.notEqual((await storage(env, platformAal2, "POST", `workspace-assets/${objectPath}`, "granted upload")).status, 200,
      "a write grant alone uploaded an object");
    assert.notEqual((await storage(env, platformAal2, "DELETE", logo)).status, 200, "a write grant alone deleted an object");
    await revokeGrant(grant.body.id);

    const objects = await db.query<{ name: string }>(
      "select name from storage.objects where bucket_id = 'workspace-assets' and name = any($1)",
      [[objectPath, `${wsA}/logo-${run}.txt`]]);
    assert.deepEqual(objects.rows.map((r) => r.name), [`${wsA}/logo-${run}.txt`], "the asset survives and nothing was uploaded");
    const storageAudit = await db.query("select count(*)::int n from public.workspace_audit_log where grant_id = $1 and action like 'storage.%'",
      [grant.body.id]);
    assert.equal(storageAudit.rows[0].n, 0);
    const memberUploads = await db.query(
      "select count(*)::int n from public.workspace_audit_log where action like 'storage.%' and metadata ->> 'object_path' like $1",
      [`%/logo-${run}.txt`]);
    assert.equal(memberUploads.rows[0].n, 0, "member uploads must not be recorded as platform actions");
  });

  test("suspension blocks members; only read grants still work", async () => {
    await voidRpc(platformAal2, "platform_suspend_workspace", { p_workspace_id: wsB, p_reason: "stack test suspension" });
    let reactivated = false;
    try {
      assert.deepEqual(await contacts(ownerB.token), []);
      const w = await rest(env, ownerB.token, "POST", "contacts", { workspace_id: wsB, first_name: "While suspended" });
      assert.ok(denied(w.status), `suspended member insert returned ${w.status}`);
      const asset = await storage(env, ownerB.token, "GET", `workspace-assets/${wsB}/logo-${run}.txt`);
      assert.notEqual(asset.status, 200, "suspended workspace asset still readable");

      const writeGrant = await grantAccess(wsB, "write", "stack test suspended write");
      assert.notEqual(writeGrant.status, 200, "write grant issued for a suspended workspace");
      const readGrant = await grantAccess(wsB, "read", "stack test suspended read");
      assert.equal(readGrant.status, 200, readGrant.text);
      assert.deepEqual((await contacts(platformAal2)).map((c) => c.id), [contactB]);
      await revokeGrant(readGrant.body.id);

      await voidRpc(platformAal2, "platform_reactivate_workspace", { p_workspace_id: wsB, p_reason: "stack test reactivation" });
      reactivated = true;
      assert.deepEqual((await contacts(ownerB.token)).map((c) => c.id), [contactB]);
    } finally {
      if (!reactivated) {
        await rpc(env, platformAal2, "platform_reactivate_workspace", { p_workspace_id: wsB, p_reason: "stack test cleanup reactivation" });
      }
    }
  });

  test("Storage update (PUT) and upsert require active membership plus settings.write", async () => {
    const objectPath = `${wsA}/logo-${run}.txt`;
    const obj = `workspace-assets/${objectPath}`;
    assert.equal((await storage(env, ownerA.token, "PUT", obj, "owner v2")).status, 200);
    assert.equal((await storage(env, ownerA.token, "POST", obj, "owner v3", { upsert: true })).status, 200);
    assert.equal((await storage(env, ownerA.token, "GET", obj)).text, "owner v3");

    assert.notEqual((await storage(env, ownerB.token, "PUT", obj, "intruder")).status, 200, "other workspace updated the object");
    assert.notEqual((await storage(env, ownerB.token, "POST", obj, "intruder", { upsert: true })).status, 200, "other workspace upserted");
    assert.equal((await storage(env, ownerA.token, "GET", obj)).text, "owner v3");

    const grant = await grantAccess(wsA, "write", "stack test storage update write grant");
    assert.equal(grant.status, 200, grant.text);
    assert.equal((await storage(env, platformAal2, "GET", obj)).text, "owner v3", "write grants keep read access");
    assert.notEqual((await storage(env, platformAal2, "PUT", obj, "granted v4")).status, 200, "a write grant alone updated");
    assert.notEqual((await storage(env, platformAal2, "POST", obj, "granted v5", { upsert: true })).status, 200, "a write grant alone upserted");
    await revokeGrant(grant.body.id);
    assert.notEqual((await storage(env, platformAal2, "GET", obj)).status, 200, "revoked grant still reads");
    assert.equal((await storage(env, ownerA.token, "GET", obj)).text, "owner v3");

    const audit = await db.query("select count(*)::int n from public.workspace_audit_log where grant_id = $1 and action like 'storage.%'",
      [grant.body.id]);
    assert.equal(audit.rows[0].n, 0);
  });

  test("permission overrides change what an employee can do through PostgREST and Storage", async () => {
    const emp = await signUp(env, email("employee-override"), "Override Employee");
    const inv = await rpc(env, ownerA.token, "create_invitation", { p_email: emp.email, p_role: "employee", p_ttl_hours: 72 });
    assert.equal(inv.status, 200, inv.text);
    assert.equal((await rpc(env, emp.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
    const obj = `workspace-assets/${wsA}/override-${run}.txt`;
    const setOverride = (permission: string, allowed: boolean | null) =>
      rpc(env, ownerA.token, "set_member_permission", { p_user_id: emp.id, p_permission: permission, p_allowed: allowed });

    try {
      assert.notEqual((await storage(env, emp.token, "POST", obj, "no override")).status, 200);
      assertVoidOk(await setOverride("settings.write", true), "allow settings.write");
      assert.equal((await storage(env, emp.token, "POST", obj, "with override")).status, 200);
      assertVoidOk(await setOverride("settings.write", null), "clear settings.write");
      assert.notEqual((await storage(env, emp.token, "PUT", obj, "override cleared")).status, 200);

      assertVoidOk(await setOverride("contacts.write", false), "deny contacts.write");
      const blocked = await rest(env, emp.token, "POST", "contacts", { workspace_id: wsA, first_name: "Denied by override" });
      assert.ok(denied(blocked.status), `deny override insert returned ${blocked.status}`);
      assertVoidOk(await setOverride("contacts.write", null), "clear contacts.write");
    } finally {
      await setOverride("settings.write", null);
      await setOverride("contacts.write", null);
    }
    const allowed = await rest(env, emp.token, "POST", "contacts", { workspace_id: wsA, first_name: "Override cleared" });
    assert.equal(allowed.status, 201, allowed.text);

    const team = await rpc(env, emp.token, "set_member_permission", { p_user_id: ownerA.id, p_permission: "contacts.read", p_allowed: false });
    assert.ok(denied(team.status), `employee set an override: ${team.status}`);
    const escalate = await setOverride("team.change_role", true);
    assert.notEqual(escalate.status, 200, "override granted a team power");
  });

  test("concurrent provisioning and double invitation acceptance over PostgREST settle to one outcome", async () => {
    const key = `synthetic-concurrent-${run}`;
    const owner = email("concurrent-owner");
    const args = { p_provisioning_key: key, p_name: "Concurrent (synthetic)", p_slug: `concurrent-synthetic-${run}`, p_owner_email: owner };
    const [p1, p2] = await Promise.all([
      rpc(env, platformAal2, "platform_provision_workspace", args),
      rpc(env, platformAal2, "platform_provision_workspace", args),
    ]);
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p2.status, 200, p2.text);
    assert.equal(p1.body.workspace_id, p2.body.workspace_id);
    assert.deepEqual([p1.body.created, p2.body.created].sort(), [false, true]);
    const creator = p1.body.created ? p1.body : p2.body;
    assert.equal((p1.body.created ? p2.body : p1.body).invite_token, null);
    const ws = await db.query<{ n: number }>("select count(*)::int n from public.workspaces where provisioning_key = $1", [key]);
    assert.equal(ws.rows[0].n, 1);

    const user = await signUp(env, owner, "Concurrent Owner");
    const [a1, a2] = await Promise.all([
      rpc(env, user.token, "accept_invitation", { p_token: creator.invite_token }),
      rpc(env, user.token, "accept_invitation", { p_token: creator.invite_token }),
    ]);
    const statuses = [a1.status, a2.status].sort();
    assert.equal(statuses[0], 200);
    assert.notEqual(statuses[1], 200, "the same invitation was accepted twice");
    assert.match((a1.status === 200 ? a2 : a1).text, /invitation_used|already_member/);
    const members = await db.query<{ n: number }>(
      "select count(*)::int n from public.workspace_members where workspace_id = $1 and status = 'active'", [creator.workspace_id]);
    assert.equal(members.rows[0].n, 1);
  });

  test("a one-minute platform grant expires by the clock across PostgREST and Storage", async () => {
    // A workspace of its own, so no other grant (live or leaked) can keep access open.
    const owner = await signUp(env, email("expiry-owner"), "Expiry Owner");
    const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
      p_provisioning_key: `synthetic-expiry-${run}`, p_name: "Expiry (synthetic)",
      p_slug: `expiry-synthetic-${run}`, p_owner_email: owner.email,
    });
    assert.equal(prov.status, 200, prov.text);
    const ws: string = prov.body.workspace_id;
    assert.equal((await rpc(env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
    const seeded = await rest(env, owner.token, "POST", "contacts", { workspace_id: ws, first_name: "Expiry fixture" });
    assert.equal(seeded.status, 201, seeded.text);
    const logo = `workspace-assets/${ws}/logo-${run}.txt`;
    assert.equal((await storage(env, owner.token, "POST", logo, "expiry asset")).status, 200);
    assert.deepEqual(await activeGrants(ws), [], "the expiry workspace must start with no grants");

    const grant = await grantAccess(ws, "write", "stack test clock expiry", 1);
    assert.equal(grant.status, 200, grant.text);
    assert.deepEqual(await activeGrants(ws), [grant.body.id], "only the one-minute grant may be live");
    assert.deepEqual((await contacts(platformAal2)).map((c) => c.id), [seeded.body[0].id]);
    assert.equal((await storage(env, platformAal2, "GET", logo)).status, 200);

    const deadline = Date.now() + 120_000;
    for (;;) {
      const r = await db.query<{ expired: boolean }>("select now() > $1::timestamptz + interval '1 second' expired", [grant.body.expires_at]);
      if (r.rows[0].expired) break;
      if (Date.now() > deadline) throw new Error("grant did not reach its expiry time");
      await new Promise((res) => setTimeout(res, 2000));
    }

    assert.deepEqual(await activeGrants(ws), []);
    assert.deepEqual(await contacts(platformAal2), []);
    const ins = await rest(env, platformAal2, "POST", "contacts", { workspace_id: ws, first_name: "After expiry" });
    assert.ok(denied(ins.status), `expired grant insert returned ${ins.status}`);
    assert.notEqual((await storage(env, platformAal2, "GET", logo)).status, 200, "expired grant still reads assets");
    assert.notEqual((await storage(env, platformAal2, "POST", `workspace-assets/${ws}/expired-${run}.txt`, "x")).status, 200);
    const ctx = await rpc(env, platformAal2, "request_context");
    assert.equal(ctx.status, 200, ctx.text);
    assert.equal(ctx.body.grant, null);
    assert.equal(ctx.body.workspace, null);
    const row = await db.query("select revoked_at from public.platform_access_grants where id = $1", [grant.body.id]);
    assert.equal(row.rows[0].revoked_at, null, "expiry must not depend on revocation");
    liveGrants.delete(grant.body.id);
  });

  test("legacy tables are closed to anon and authenticated, open to the service role", async () => {
    for (const t of LEGACY_TABLES) {
      const anon = await rest(env, null, "GET", `${t}?select=*&limit=1`);
      assert.ok(denied(anon.status), `anon ${t} returned ${anon.status}`);
      const user = await rest(env, ownerA.token, "GET", `${t}?select=*&limit=1`);
      assert.ok(denied(user.status), `authenticated ${t} returned ${user.status}`);
      const svc = await serviceRest(env, `${t}?select=*&limit=1`);
      assert.equal(svc.status, 200, `service role ${t} returned ${svc.status}`);
    }
    const privs = await db.query(
      `select c.relname, c.relrowsecurity,
              has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon_any,
              has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as auth_any
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1)`,
      [LEGACY_TABLES]
    );
    assert.equal(privs.rows.length, LEGACY_TABLES.length);
    for (const r of privs.rows) {
      assert.equal(r.relrowsecurity, true, `${r.relname} RLS`);
      assert.equal(r.anon_any, false, `${r.relname} anon privileges`);
      assert.equal(r.auth_any, false, `${r.relname} authenticated privileges`);
    }
  });

  // P2: the production build of the app with AUTH_PROVIDER=supabase, signing in through its own
  // /api/auth/login against real GoTrue. Pages and APIs are requested without following redirects.
  describe("the app with AUTH_PROVIDER=supabase (P2)", () => {
    let app: App;
    let ownerCookie = "";

    // Page denials must be decided by middleware (a real 307 before rendering). A redirect() from the
    // layout alone streams as HTTP 200 while Next renders the page in parallel, which leaked page
    // content in the first P2 run; the markers prove none of the gated page is sent.
    const pageRedirect = (r: Awaited<ReturnType<typeof appFetch>>, label: string, gatedMarkers: string[]) => {
      assert.equal(r.status, 307, `${label}: status ${r.status}`);
      assert.ok(r.location, `${label}: no Location`);
      for (const m of gatedMarkers) assert.equal(r.text.includes(m), false, `${label}: gated content "${m}" was sent`);
      return new URL(r.location!, app.url);
    };
    const DASHBOARD = ["Needs Attention", "Recent Activity", "Quick Actions"];

    before(async () => {
      app = await startApp(env);
    });

    after(() => {
      app?.stop();
    });

    test("AUTH-1: login, me, and logout follow the §7.2 contracts with httpOnly Supabase cookies", async () => {
      const wrong = await appFetch(app, "/api/auth/login", { method: "POST", json: { email: ownerA.email, password: "wrong-password" } });
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.body, { ok: false, error: "Invalid credentials", code: "unauthenticated" });
      const unknown = await appFetch(app, "/api/auth/login", { method: "POST", json: { email: email("nobody"), password: "x" } });
      assert.deepEqual([unknown.status, unknown.body], [401, wrong.body], "unknown accounts get the same generic answer");

      const login = await appFetch(app, "/api/auth/login", { method: "POST", json: { email: ownerA.email, password: ownerA.password } });
      assert.equal(login.status, 200, login.text);
      assert.deepEqual(login.body, { ok: true, user: { id: ownerA.id, email: ownerA.email, name: "Owner A" } });
      const auth = login.setCookies.filter((c) => /^sb-.+-auth-token/.test(c));
      assert.ok(auth.length >= 1, "a Supabase session cookie is set");
      for (const c of auth) {
        assert.match(c, /HttpOnly/i);
        assert.match(c, /SameSite=Lax/i);
        assert.match(c, /Path=\//);
      }
      assert.match(login.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(login.setCookies.some((c) => c.startsWith("fna_session=")), false);
      ownerCookie = cookieHeader(login.setCookies);

      const me = await appFetch(app, "/api/auth/me", { cookie: ownerCookie });
      assert.equal(me.status, 200, me.text);
      assert.deepEqual(
        { ...me.body, permissions: undefined },
        { ok: true, authEnforced: true, user: { id: ownerA.id, email: ownerA.email, name: "Owner A" }, role: "owner",
          legacyRole: "OWNER", permissions: undefined, isPlatformAdmin: false, grant: null,
          workspace: { id: wsA, name: "TJ Towing (synthetic)", slug: `tj-towing-synthetic-${run}`, status: "active" } });
      for (const p of ["dashboard.read", "onboarding.read", "settings.write", "team.invite_owner"]) {
        assert.ok(me.body.permissions.includes(p), p);
      }

      assert.equal((await appFetch(app, "/dashboard", { cookie: ownerCookie })).status, 200);
      assert.equal((await appFetch(app, "/onboarding", { cookie: ownerCookie })).status, 200);
      assert.equal((await appFetch(app, "/library", { cookie: ownerCookie })).status, 200);
      const root = await appFetch(app, "/", { cookie: ownerCookie });
      assert.equal(root.status, 307);
      assert.equal(new URL(root.location!, app.url).pathname, "/dashboard");

      const throwaway = await appLogin(app, ownerA);
      const logout = await appFetch(app, "/api/auth/logout", { method: "POST", cookie: throwaway });
      assert.equal(logout.status, 200);
      assert.deepEqual(logout.body, { ok: true });
      const cleared = logout.setCookies.filter((c) => /^sb-.+-auth-token/.test(c));
      assert.ok(cleared.length >= 1, "logout clears the session cookie");
      for (const c of cleared) assert.match(c, /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      const signedOut = await appFetch(app, "/api/auth/me");
      assert.equal(signedOut.body.user, null);
      // M21: the logged-out session's row is gone, so its still-unexpired access token is refused
      // for reads, and directly at the Data API.
      const replayApi = await appFetch(app, "/api/tenant/config", { cookie: throwaway });
      assert.equal(replayApi.status, 401, `replayed cookie after logout: ${replayApi.status}`);
      const replayToken = readSessionCookie(throwaway).session.access_token;
      assert.equal((await rest(env, replayToken, "GET", "workspaces?select=id")).status, 401);
      // Logging out one session does not end the owner's other session (scope: local).
      assert.equal((await appFetch(app, "/api/auth/me", { cookie: ownerCookie })).body.user?.id, ownerA.id);
    });

    test("refreshed sessions reach the browser: expired access token + valid refresh token (finding 3)", async () => {
      for (const path of ["/api/auth/me", "/api/tenant/config", "/api/workspaces"]) {
        const { name, session } = readSessionCookie(await appLogin(app, ownerA));
        const now = Math.floor(Date.now() / 1000);
        const expired = { ...session, expires_at: now - 3600,
          access_token: signJwt(env.jwtSecret, { ...jwtPayload(session.access_token), iat: now - 7200, exp: now - 3600 }) };
        const r = await appFetch(app, path, { cookie: sessionCookie(name, expired) });
        assert.equal(r.status, 200, `${path}: ${r.status} ${r.text.slice(0, 160)}`);
        if (path === "/api/auth/me") assert.equal(r.body.user?.id, ownerA.id);
        assert.ok(r.setCookies.some((c) => /^sb-.+-auth-token/.test(c)), `${path}: the refreshed session cookie is sent`);
        const fresh = readSessionCookie(cookieHeader(r.setCookies)).session;
        assert.notEqual(fresh.refresh_token, session.refresh_token, `${path}: rotated refresh token`);
        assert.ok(fresh.expires_at > now, `${path}: new access token is current`);
        const next = await appFetch(app, "/api/auth/me", { cookie: cookieHeader(r.setCookies) });
        assert.equal(next.body.user?.id, ownerA.id, `${path}: the browser's next request works with the new cookie`);
      }
    });

    test("JSON bodies must be objects with correctly typed fields (finding 4)", async () => {
      const raw = (path: string, body: string, cookie?: string) =>
        appFetch(app, path, { method: "POST", body, contentType: "application/json", cookie });
      for (const body of ["null", "[]", "42", "\"x\"", "{bad", JSON.stringify({ email: 1, password: "x" }),
        JSON.stringify({ email: ownerA.email, password: { $ne: "" } }), JSON.stringify({ email: [ownerA.email], password: ownerA.password })]) {
        const r = await raw("/api/auth/login", body);
        assert.deepEqual([r.status, r.body?.code], [400, "validation_failed"], `login ${body}`);
      }
      const cookie = await appLogin(app, ownerA);
      for (const body of ["null", "[]", "42", JSON.stringify({ workspaceId: 1 }), JSON.stringify({ workspaceId: null }),
        JSON.stringify({ workspaceId: [wsA] })]) {
        const r = await raw("/api/workspaces/active", body, cookie);
        assert.deepEqual([r.status, r.body?.code], [422, "validation_failed"], `switch ${body}`);
      }
    });

    test("signed-out requests: protected pages 307 to /login?next=…, protected APIs 401 JSON", async () => {
      const page = await appFetch(app, "/contacts");
      assert.equal(page.status, 307);
      const loc = new URL(page.location!, app.url);
      assert.deepEqual([loc.pathname, loc.searchParams.get("next")], ["/login", "/contacts"]);
      for (const path of ["/api/dashboard/summary", "/api/tenant/config", "/api/workspaces", "/api/team"]) {
        const r = await appFetch(app, path);
        assert.equal(r.status, 401, path);
        assert.equal(r.body.code, "unauthenticated", path);
      }
      assert.equal((await appFetch(app, "/login")).status, 200);
    });

    test("ISO-F3: forged, tampered, expired, unsigned, and foreign-key session cookies are refused", async () => {
      const { name, session } = readSessionCookie(ownerCookie);
      const claims = jwtPayload(session.access_token);
      const [h, p] = session.access_token.split(".");
      const now = Math.floor(Date.now() / 1000);
      const variants: Record<string, object> = {
        "tampered signature": { ...session, access_token: `${h}.${p}.${Buffer.from("forged").toString("base64url")}` },
        "expired, bad refresh token": { ...session, access_token: signJwt(env.jwtSecret, { ...claims, iat: now - 7200, exp: now - 3600 }),
          refresh_token: "not-a-refresh-token", expires_at: now - 3600 },
        "unsigned (alg none)": { ...session,
          access_token: `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${p}.` },
        "signed by another key": { ...session, access_token: signJwt("y".repeat(40), { ...claims, role: "authenticated" }) },
        "another user's id in a forged token": { ...session,
          access_token: signJwt("z".repeat(40), { ...claims, sub: ownerB.id, email: ownerB.email }) },
      };
      for (const [label, forged] of Object.entries(variants)) {
        const cookie = sessionCookie(name, forged);
        const api = await appFetch(app, "/api/tenant/config", { cookie });
        assert.equal(api.status, 401, `${label}: API ${api.status} ${api.text.slice(0, 120)}`);
        const page = await appFetch(app, "/dashboard", { cookie });
        assert.equal(page.status, 307, `${label}: page ${page.status}`);
        assert.equal(new URL(page.location!, app.url).pathname, "/login", label);
        const me = await appFetch(app, "/api/auth/me", { cookie });
        assert.equal(me.body?.user ?? null, null, `${label}: /api/auth/me must not report a user`);
      }
    });

    test("ISO-F4: a legacy fna_session cookie is ignored", async () => {
      const r = await appFetch(app, "/api/tenant/config", { cookie: "fna_session=legacy.session-token" });
      assert.equal(r.status, 401);
      const page = await appFetch(app, "/dashboard", { cookie: "fna_session=legacy.session-token" });
      assert.equal(new URL(page.location!, app.url).pathname, "/login");
    });

    test("permissions gate pages and APIs: employees, outsiders, and §4.3 Setup/Resources", async () => {
      const emp = await signUp(env, email("app-employee"), "App Employee");
      const inv = await rpc(env, ownerA.token, "create_invitation", { p_email: emp.email, p_role: "employee", p_ttl_hours: 72 });
      assert.equal(inv.status, 200, inv.text);
      assert.equal((await rpc(env, emp.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
      const cookie = await appLogin(app, emp);

      const me = await appFetch(app, "/api/auth/me", { cookie });
      assert.deepEqual([me.body.role, me.body.legacyRole, me.body.workspace.id], ["employee", "CLIENT", wsA]);
      assert.equal(me.body.permissions.includes("onboarding.read"), false);
      assert.equal(me.body.permissions.includes("library.read"), false);
      assert.equal((await appFetch(app, "/dashboard", { cookie })).status, 200);
      for (const [path, markers] of [["/onboarding", ["Configuration readiness", "Onboarding / Setup Checklist"]],
        ["/library", ["Email drafts", "Text drafts"]]] as const) {
        const loc = pageRedirect(await appFetch(app, path, { cookie }), path, [...markers]);
        assert.deepEqual([loc.pathname, loc.searchParams.get("denied")], ["/dashboard", "1"], path);
      }
      const owner = await appFetch(app, "/api/audit", { cookie });
      assert.deepEqual([owner.status, owner.body.code], [403, "forbidden"]);
      const config = await appFetch(app, "/api/tenant/config", { cookie });
      assert.equal(config.status, 200, config.text);
      assert.equal(config.body.owner, undefined, "only owners receive the owner block");

      const outsiderCookie = await appLogin(app, outsider);
      const page = await appFetch(app, "/dashboard", { cookie: outsiderCookie });
      assert.equal(pageRedirect(page, "outsider /dashboard", DASHBOARD).pathname, "/no-access");
      const api = await appFetch(app, "/api/tenant/config", { cookie: outsiderCookie });
      assert.deepEqual([api.status, api.body.code], [403, "no_active_workspace"]);
      assert.equal((await appFetch(app, "/no-access", { cookie: outsiderCookie })).status, 200);
      const outsiderMe = await appFetch(app, "/api/auth/me", { cookie: outsiderCookie });
      assert.deepEqual([outsiderMe.body.user.id, outsiderMe.body.workspace, outsiderMe.body.permissions], [outsider.id, null, []]);
    });

    test("MEM-1 and SUSP-1 through the app: removal and suspension apply on the next request with the same session", async () => {
      const member = await signUp(env, email("app-member-b"), "App Member B");
      const inv = await rpc(env, ownerB.token, "create_invitation", { p_email: member.email, p_role: "employee", p_ttl_hours: 72 });
      assert.equal(inv.status, 200, inv.text);
      assert.equal((await rpc(env, member.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
      const memberCookie = await appLogin(app, member);
      const ownerBCookie = await appLogin(app, ownerB);
      assert.equal((await appFetch(app, "/api/tenant/config", { cookie: memberCookie })).status, 200);

      await voidRpc(ownerB.token, "remove_member", { p_user_id: member.id });
      const removed = await appFetch(app, "/api/tenant/config", { cookie: memberCookie });
      assert.deepEqual([removed.status, removed.body.code], [403, "no_active_workspace"]);
      const removedPage = await appFetch(app, "/dashboard", { cookie: memberCookie });
      assert.equal(pageRedirect(removedPage, "removed member /dashboard", DASHBOARD).pathname, "/no-access");

      await voidRpc(platformAal2, "platform_suspend_workspace", { p_workspace_id: wsB, p_reason: "app suspension test" });
      let reactivated = false;
      try {
        const api = await appFetch(app, "/api/tenant/config", { cookie: ownerBCookie });
        assert.deepEqual([api.status, api.body.code], [423, "workspace_suspended"]);
        const page = await appFetch(app, "/dashboard", { cookie: ownerBCookie });
        assert.equal(pageRedirect(page, "suspended /dashboard", DASHBOARD).pathname, "/workspace-suspended");
        assert.equal((await appFetch(app, "/workspace-suspended", { cookie: ownerBCookie })).status, 200);
        await voidRpc(platformAal2, "platform_reactivate_workspace", { p_workspace_id: wsB, p_reason: "app reactivation test" });
        reactivated = true;
        assert.equal((await appFetch(app, "/api/tenant/config", { cookie: ownerBCookie })).status, 200);
      } finally {
        if (!reactivated) {
          await rpc(env, platformAal2, "platform_reactivate_workspace", { p_workspace_id: wsB, p_reason: "app cleanup reactivation" });
        }
      }
    });

    test("/api/workspaces lists memberships and /api/workspaces/active switches only to allowed workspaces", async () => {
      const dual = await signUp(env, email("app-dual"), "App Dual");
      for (const [owner, ws] of [[ownerA, wsA], [ownerB, wsB]] as const) {
        const inv = await rpc(env, owner.token, "create_invitation", { p_email: dual.email, p_role: "employee", p_ttl_hours: 72 });
        assert.equal(inv.status, 200, `${ws}: ${inv.text}`);
        assert.equal((await rpc(env, dual.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
      }
      const cookie = await appLogin(app, dual);
      const listed = await appFetch(app, "/api/workspaces", { cookie });
      assert.equal(listed.status, 200, listed.text);
      assert.deepEqual(listed.body.workspaces.map((x: any) => [x.id, x.role, x.grantMode]).sort(),
        [[wsA, "employee", null], [wsB, "employee", null]].sort());

      const toA = await appFetch(app, "/api/workspaces/active", { method: "POST", cookie, json: { workspaceId: wsA } });
      assert.equal(toA.status, 200, toA.text);
      assert.equal(toA.body.workspace.id, wsA);
      assert.equal((await appFetch(app, "/api/auth/me", { cookie })).body.workspace.id, wsA);

      const foreign = await appFetch(app, "/api/workspaces/active", { method: "POST", cookie, json: { workspaceId: "00000000-0000-4000-8000-000000000123" } });
      assert.deepEqual([foreign.status, foreign.body.code], [403, "forbidden"]);
      const invalid = await appFetch(app, "/api/workspaces/active", { method: "POST", cookie, json: { workspaceId: "B" } });
      assert.deepEqual([invalid.status, invalid.body.code], [422, "validation_failed"]);
      assert.equal((await appFetch(app, "/api/auth/me", { cookie })).body.workspace.id, wsA, "refused switches change nothing");

      const outsiderCookie = await appLogin(app, outsider);
      const intruder = await appFetch(app, "/api/workspaces/active", { method: "POST", cookie: outsiderCookie, json: { workspaceId: wsB } });
      assert.deepEqual([intruder.status, intruder.body.code], [403, "forbidden"]);
    });

    test("platform Storage endpoint: only a write grant can change the logo, every change is audited, members are refused", async () => {
      const admin = await signUp(env, email("app-platform"), "App Platform Admin");
      await db.query("insert into public.platform_admins (user_id) values ($1)", [admin.id]);
      const aal2 = await upgradeToAal2Session(env, admin);
      const { name } = readSessionCookie(ownerCookie);
      const adminCookie = sessionCookie(name, aal2);
      const logoPath = `${wsA}/logo.png`;
      const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
      const put = (cookie: string, body: BodyInit = png, contentType = "image/png") =>
        appFetch(app, "/api/platform/workspace-logo", { method: "PUT", cookie, body, contentType });
      const storageAudit = async (grantId: string) =>
        (await db.query<{ action: string; target: string; actor_id: string; actor_kind: string; metadata: any }>(
          `select action, target, actor_id, actor_kind, metadata from public.workspace_audit_log
           where grant_id = $1 and action like 'storage.%' order by id`, [grantId])).rows;
      const grantAs = async (mode: "read" | "write") => {
        const r = await rpc(env, aal2.access_token, "platform_grant_access", {
          p_workspace_id: wsA, p_mode: mode, p_reason: `app storage endpoint ${mode} test`, p_minutes: 15 });
        assert.equal(r.status, 200, r.text);
        return r.body.id as string;
      };
      const revoke = (id: string) => voidRpc(aal2.access_token, "platform_revoke_access", { p_grant_id: id, p_reason: "Support session finished" });

      const noGrant = await put(adminCookie);
      assert.deepEqual([noGrant.status, noGrant.body.code], [403, "no_active_workspace"]);
      const member = await put(ownerCookie);
      assert.deepEqual([member.status, member.body.code], [403, "forbidden"], "members use Storage directly");

      const readGrant = await grantAs("read");
      try {
        const r = await put(adminCookie);
        assert.deepEqual([r.status, r.body.code], [403, "forbidden"]);
        assert.deepEqual(await storageAudit(readGrant), []);
        assert.equal((await appFetch(app, "/dashboard", { cookie: adminCookie })).status, 200, "a read grant opens workspace pages");
        assert.equal((await appFetch(app, "/onboarding", { cookie: adminCookie })).status, 200, "read grants include onboarding.read");
      } finally {
        await revoke(readGrant);
      }

      const writeGrant = await grantAs("write");
      try {
        const wrongType = await put(adminCookie, "not an image", "text/plain");
        assert.deepEqual([wrongType.status, wrongType.body.code], [422, "validation_failed"]);
        assert.deepEqual(await storageAudit(writeGrant), [], "rejected input writes no audit row");

        const ok = await put(adminCookie);
        assert.equal(ok.status, 200, ok.text);
        assert.deepEqual(ok.body, { ok: true, objectPath: logoPath, requestId: ok.body.requestId, outcome: "succeeded" });
        const stored = await storage(env, ownerA.token, "GET", `workspace-assets/${logoPath}`);
        assert.equal(stored.status, 200, "the owner can read the logo the platform admin uploaded");
        const tagged = await db.query<{ tagged: boolean }>(
          `select o.user_metadata ->> 'platform_operation' = c.token::text tagged
           from storage.objects o join private.platform_storage_changes c on c.request_id = $2
           where o.bucket_id = 'workspace-assets' and o.name = $1`, [logoPath, ok.body.requestId]);
        assert.deepEqual(tagged.rows, [{ tagged: true }], "the real upload carries this operation's token");
        assert.equal(JSON.stringify(ok.body).includes("platform_operation"), false);
        const del = await appFetch(app, "/api/platform/workspace-logo?ext=png", { method: "DELETE", cookie: adminCookie });
        assert.equal(del.status, 200, del.text);
        const left = await db.query(
          "select count(*)::int n from storage.objects where bucket_id = 'workspace-assets' and (name = $1 or name like $2)",
          [logoPath, `${wsA}/.platform-trash/%`]);
        assert.equal(left.rows[0].n, 0, "logo deleted (moved to its tombstone) and the tombstone cleaned up");

        const audit = await storageAudit(writeGrant);
        assert.deepEqual(audit.map((a) => [a.action, a.metadata.outcome, a.target, a.actor_id, a.actor_kind, a.metadata.via]), [
          ["storage.object_upsert", "requested", `workspace-assets/${logoPath}`, admin.id, "platform_admin", "platform_endpoint"],
          ["storage.object_upsert", "succeeded", `workspace-assets/${logoPath}`, admin.id, "platform_admin", "platform_endpoint"],
          ["storage.object_delete", "requested", `workspace-assets/${logoPath}`, admin.id, "platform_admin", "platform_endpoint"],
          ["storage.object_delete", "succeeded", `workspace-assets/${logoPath}`, admin.id, "platform_admin", "platform_endpoint"],
        ]);
        assert.ok(audit.filter((a) => a.metadata.outcome !== "requested").every((a) => a.metadata.recorded_by === "server"));

        // Finding 1: outcomes are server-only. The platform admin's own JWT cannot record or fabricate one,
        // and the old client-controlled (bigint, boolean) signature no longer exists.
        const fabricate = await rpc(env, aal2.access_token, "platform_storage_change_finished",
          { p_request_id: ok.body.requestId, p_actor_id: admin.id, p_operation_returned: true });
        assert.ok(fabricate.status === 401 || fabricate.status === 403, `direct completion: ${fabricate.status} ${fabricate.text}`);
        for (const args of [{ p_request_id: ok.body.requestId, p_succeeded: true }, { p_request_id: ok.body.requestId, p_actor_id: admin.id }]) {
          const oldSignature = await rpc(env, aal2.access_token, "platform_storage_change_finished", args);
          assert.equal(oldSignature.status, 404, `old signature ${Object.keys(args).join(",")}: ${oldSignature.text}`);
        }
        const spoofRequest = await rpc(env, aal2.access_token, "platform_storage_change_requested",
          { p_operation: "upsert", p_object_path: logoPath });
        assert.equal(spoofRequest.status, 200, "a request alone is allowed (it is only a request)");
        const outcomeRows = async (id: number) => (await db.query(
          "select metadata ->> 'outcome' o from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)])).rows;
        assert.deepEqual(await outcomeRows(spoofRequest.body), [], "a client cannot complete it");
        const directClaim = await rpc(env, aal2.access_token, "platform_storage_change_claimed",
          { p_request_id: spoofRequest.body, p_actor_id: admin.id });
        assert.ok(directClaim.status === 401 || directClaim.status === 403, `direct claim: ${directClaim.status}`);

        // Finding 2: completion failure is explicit and recoverable. Make the completion RPC fail for the
        // server, perform a real change, then restore it and recover the pending request.
        let pendingId = 0;
        await db.query("revoke execute on function public.platform_storage_change_finished(bigint, uuid, boolean) from service_role");
        try {
          const pending = await put(adminCookie);
          assert.equal(pending.status, 503, pending.text);
          assert.equal(pending.body.code, "audit_pending");
          pendingId = pending.body.requestId;
          assert.ok(Number.isSafeInteger(pendingId) && pendingId > 0);
          assert.deepEqual(await outcomeRows(pendingId), [], "no outcome guessed while completion is down");
          const stored2 = await db.query("select count(*)::int n from storage.objects where bucket_id = 'workspace-assets' and name = $1", [logoPath]);
          assert.equal(stored2.rows[0].n, 1, "the change itself happened");
          const stillDown = await appFetch(app, "/api/platform/workspace-logo", { method: "POST", cookie: adminCookie, json: { requestId: pendingId } });
          assert.deepEqual([stillDown.status, stillDown.body.code], [503, "audit_pending"]);
          const blocked = await put(adminCookie);
          assert.deepEqual([blocked.status, blocked.body.code], [409, "change_pending"], "no new change while one is pending");
        } finally {
          await db.query("grant execute on function public.platform_storage_change_finished(bigint, uuid, boolean) to service_role");
        }
        const recovered = await appFetch(app, "/api/platform/workspace-logo", { method: "POST", cookie: adminCookie, json: { requestId: pendingId } });
        assert.equal(recovered.status, 200, recovered.text);
        assert.deepEqual(recovered.body, { ok: true, requestId: pendingId, outcome: "succeeded" });
        const again = await appFetch(app, "/api/platform/workspace-logo", { method: "POST", cookie: adminCookie, json: { requestId: pendingId } });
        assert.deepEqual(again.body, recovered.body, "recovery is idempotent");
        assert.deepEqual(await outcomeRows(pendingId), [{ o: "succeeded" }], "exactly one outcome");
        const spoofDone = await appFetch(app, "/api/platform/workspace-logo", { method: "POST", cookie: adminCookie, json: { requestId: spoofRequest.body } });
        assert.deepEqual([spoofDone.status, spoofDone.body.code], [404, "not_found"],
          "a request the server never claimed gets no outcome, although the object changed meanwhile");
        assert.deepEqual(await outcomeRows(spoofRequest.body), []);
        const cleanup = await appFetch(app, "/api/platform/workspace-logo?ext=png", { method: "DELETE", cookie: adminCookie });
        assert.equal(cleanup.status, 200, cleanup.text);

        // Audit lifecycle with the real Storage API. The server's own steps (claim as the service role,
        // then its tagged write) are driven directly so the write can be held "in flight" while the
        // admin calls the app's recovery endpoint.
        const recover = (requestId: number) =>
          appFetch(app, "/api/platform/workspace-logo", { method: "POST", cookie: adminCookie, json: { requestId } });
        const serverClaim = async () => {
          const r = await rpc(env, aal2.access_token, "platform_storage_change_requested", { p_operation: "upsert", p_object_path: logoPath });
          assert.equal(r.status, 200, r.text);
          const c = await rpc(env, env.serviceRoleKey, "platform_storage_change_claimed", { p_request_id: r.body, p_actor_id: admin.id });
          assert.equal(c.status, 200, c.text);
          return { id: Number(r.body), token: String(c.body) };
        };
        const realUpload = (bearer: string, metadata: Record<string, unknown>) =>
          fetch(`${env.apiUrl}/storage/v1/object/workspace-assets/${logoPath}`, {
            method: "POST",
            headers: { apikey: env.anonKey, Authorization: `Bearer ${bearer}`, "Content-Type": "image/png", "x-upsert": "true",
              "x-metadata": Buffer.from(JSON.stringify(metadata)).toString("base64") },
            body: png,
          });
        const logoOwner = async () => (await db.query<{ owner_id: string | null; tagged: string | null }>(
          `select nullif(owner_id, '') owner_id, user_metadata ->> 'platform_operation' tagged
           from storage.objects where bucket_id = 'workspace-assets' and name = $1`, [logoPath])).rows[0];

        // Recovery racing an in-flight write: nothing is recorded and the claim is kept.
        const flight = await serverClaim();
        const early = await recover(flight.id);
        assert.deepEqual([early.status, early.body.code, early.body.requestId], [409, "operation_in_progress", flight.id], early.text);
        assert.equal(early.headers.get("retry-after"), "120");
        assert.deepEqual(await outcomeRows(flight.id), [], "no outcome while the operation may still be running");
        const blockedByFlight = await put(adminCookie);
        assert.deepEqual([blockedByFlight.status, blockedByFlight.body.code], [409, "change_pending"], "the claim is not released");
        const landed = await realUpload(env.serviceRoleKey, { platform_operation: flight.token });
        assert.equal(landed.status, 200, await landed.text());
        const afterFlight = await recover(flight.id);
        assert.deepEqual([afterFlight.status, afterFlight.body.outcome], [200, "succeeded"], "its own write committed");
        assert.equal((await logoOwner())?.tagged, flight.token);

        // A member writes the same object while a platform request is pending: never a platform success.
        // The real Storage API commits member and server uploads alike, so attribution rests on the
        // pending token, which only the server knows; a re-upload carrying the previous operation's
        // token over unchanged is neither attributed nor refused. After the lease, recording 'failed'
        // fences the operation's late write.
        const pendingOp = await serverClaim();
        const memberCarryOver = await realUpload(ownerA.token, { platform_operation: flight.token });
        assert.equal(memberCarryOver.status, 200, await memberCarryOver.text());
        const memberWrite = await realUpload(ownerA.token, { note: "member logo" });
        assert.equal(memberWrite.status, 200, await memberWrite.text());
        assert.equal((await logoOwner())?.owner_id, ownerA.id, "the member's own write is stored");
        assert.equal((await recover(pendingOp.id)).status, 409, "still within the lease");
        await db.query("update private.platform_storage_changes set claimed_at = claimed_at - interval '3 minutes' where request_id = $1", [pendingOp.id]);
        const fenced = await recover(pendingOp.id);
        assert.deepEqual([fenced.status, fenced.body.code, fenced.body.outcome], [502, "storage_failed", "failed"], fenced.text);
        const lateWrite = await realUpload(env.serviceRoleKey, { platform_operation: pendingOp.token });
        assert.ok(lateWrite.status >= 400, `the operation's late write is refused by the Storage API: ${lateWrite.status}`);
        assert.equal((await logoOwner())?.owner_id, ownerA.id, "the late write never took effect");
        assert.deepEqual(await outcomeRows(pendingOp.id), [{ o: "failed" }]);
        const finalCleanup = await appFetch(app, "/api/platform/workspace-logo?ext=png", { method: "DELETE", cookie: adminCookie });
        assert.equal(finalCleanup.status, 200, finalCleanup.text);
        const auditCount = (await storageAudit(writeGrant)).length;

        // A password (AAL1) session of the same platform admin is not a platform admin.
        const aal1Cookie = await appLogin(app, admin);
        const aal1 = await put(aal1Cookie);
        assert.equal(aal1.status, 403, aal1.text);
        assert.equal((await storageAudit(writeGrant)).length, auditCount);
      } finally {
        await revoke(writeGrant);
      }
      const total = (await storageAudit(writeGrant)).length;
      const afterRevoke = await put(adminCookie);
      assert.equal(afterRevoke.status, 403, afterRevoke.text);
      assert.equal((await storageAudit(writeGrant)).length, total, "nothing is recorded after revocation");

      // Once this AAL2 session is logged out, its still-unexpired cookie and token are refused (M21)
      // and nothing is recorded. The grant is revoked first, because revoking needs this session.
      assert.equal((await appFetch(app, "/api/auth/logout", { method: "POST", cookie: adminCookie })).status, 200);
      const loggedOut = await put(adminCookie);
      assert.deepEqual([loggedOut.status, loggedOut.body.code], [401, "unauthenticated"], loggedOut.text);
      assert.equal((await rpc(env, aal2.access_token, "platform_status")).status, 401);
      assert.equal((await storageAudit(writeGrant)).length, total, "a logged-out session records nothing");
    });

    // P3: pages and /api/dashboard/* read each workspace's native tables through the app, as the
    // signed-in user. Business records are created with the owners' own JWTs; reviews and activity
    // events have no client write path yet, so the superuser setup connection inserts those rows.
    describe("the app reads each workspace's native data (P3)", () => {
      let cookieA = "";
      let cookieB = "";
      const A = { contact: "", openOpp: "", wonOpp: "", calendar: "", appointment: "", message: "", task: "" };
      let contactBOnly = "";
      const NOTE_BODY = `P3 private note body ${run}`;

      const created = async (token: string, table: string, row: Record<string, unknown>) => {
        const r = await rest(env, token, "POST", table, row);
        assert.equal(r.status, 201, `${table}: ${r.status} ${r.text}`);
        return r.body[0].id as string;
      };
      const stagesOf = async (token: string) => {
        const r = await rest(env, token, "GET", "pipeline_stages?select=id,name,pipeline_id&order=position");
        assert.equal(r.status, 200, r.text);
        return r.body as { id: string; name: string; pipeline_id: string }[];
      };
      const list = async (token: string, path: string) => {
        const r = await rest(env, token, "GET", path);
        assert.equal(r.status, 200, r.text);
        return r.body as Record<string, any>[];
      };

      before(async () => {
        cookieA = await appLogin(app, ownerA);
        cookieB = await appLogin(app, ownerB);
        const stagesA = await stagesOf(ownerA.token);
        const lead = stagesA.find((s) => s.name === "New Lead")!;
        const won = stagesA.find((s) => s.name === "Won")!;
        A.contact = await created(ownerA.token, "contacts", { workspace_id: wsA, first_name: "P3 Ada", last_name: "Native",
          email: `p3-ada-${run}@example.test`, phone: "555-0199", source: "website" });
        assert.equal((await rest(env, ownerA.token, "POST", "contact_tags", { workspace_id: wsA, contact_id: A.contact, tag: "p3-vip" })).status, 201);
        A.openOpp = await created(ownerA.token, "opportunities", { workspace_id: wsA, contact_id: A.contact, pipeline_id: lead.pipeline_id,
          stage_id: lead.id, title: "P3 open", value_cents: 125050 });
        A.wonOpp = await created(ownerA.token, "opportunities", { workspace_id: wsA, contact_id: A.contact, pipeline_id: won.pipeline_id,
          stage_id: won.id, title: "P3 won", value_cents: 50000 });
        A.calendar = await created(ownerA.token, "calendars", { workspace_id: wsA, name: "P3 Discovery", slug: `p3-discovery-${run}`,
          duration_minutes: 30, is_primary: true });
        A.appointment = await created(ownerA.token, "appointments", { workspace_id: wsA, calendar_id: A.calendar, contact_id: A.contact,
          starts_at: "2031-03-04T15:00:00Z", ends_at: "2031-03-04T15:30:00Z" });
        const conversation = await created(ownerA.token, "conversations", { workspace_id: wsA, contact_id: A.contact, channel: "sms" });
        A.message = await created(ownerA.token, "messages", { workspace_id: wsA, conversation_id: conversation, direction: "internal", body: NOTE_BODY });
        A.task = await created(ownerA.token, "tasks", { workspace_id: wsA, title: "P3 call back", contact_id: A.contact });
        contactBOnly = await created(ownerB.token, "contacts", { workspace_id: wsB, first_name: "P3 Bravo-only", source: "referral" });
        await db.query(`insert into public.reviews (workspace_id, contact_id, rating, source) values ($1, $2, 5, 'manual')`,
          [wsA, A.contact]);
        await db.query(
          `insert into public.activity_events (workspace_id, entity_type, entity_id, action, actor_id, actor_kind)
           values ($1, 'contact', $2, 'created', $3, 'member')`, [wsA, A.contact, ownerA.id]);
      });

      const seededA = () => Object.values(A);

      test("API-1: every /api/dashboard/* response validates against the pre-migration shape and matches the owner's own PostgREST view", async () => {
        for (const endpoint of DASHBOARD_ENDPOINTS) {
          const r = await appFetch(app, `/api/dashboard/${endpoint}`, { cookie: cookieA });
          assert.equal(r.status, 200, `${endpoint}: ${r.status} ${r.text.slice(0, 200)}`);
          assert.deepEqual(dashboardShapeErrors(endpoint, r.body), [], endpoint);
          assert.deepEqual([r.body.source, r.body.storageMode], ["workspace", "postgres"], endpoint);
          assert.equal(r.text.includes(contactBOnly), false, `${endpoint} leaked workspace B`);
          assert.equal(r.text.includes(NOTE_BODY), false, `${endpoint} exposed a message body`);
        }

        const contacts = (await appFetch(app, "/api/dashboard/contacts", { cookie: cookieA })).body.contacts as Record<string, any>[];
        const visible = await list(ownerA.token, "contacts?select=id&deleted_at=is.null");
        assert.deepEqual(contacts.map((c) => c.id).sort(), visible.map((c) => c.id).sort(), "same rows as the owner's PostgREST view");
        assert.deepEqual(contacts.find((c) => c.id === A.contact), { id: A.contact, displayName: "P3 Ada Native", email: "[redacted]",
          phone: "[redacted]", hasEmail: true, hasPhone: true, source: "website", tags: ["p3-vip"], assignedUser: "—",
          updatedAt: contacts.find((c) => c.id === A.contact)!.updatedAt });

        const opps = (await appFetch(app, "/api/dashboard/opportunities", { cookie: cookieA })).body.opportunities as Record<string, any>[];
        const open = opps.find((o) => o.id === A.openOpp)!;
        const wonOpp = opps.find((o) => o.id === A.wonOpp)!;
        assert.deepEqual([open.stageName, open.status, open.monetaryValue], ["New Lead", "open", 1250.5]);
        assert.deepEqual([wonOpp.stageName, wonOpp.status, wonOpp.monetaryValue], ["Won", "won", 500]);

        const appts = (await appFetch(app, "/api/dashboard/appointments", { cookie: cookieA })).body.appointments as Record<string, any>[];
        const appt = appts.find((a) => a.id === A.appointment)!;
        assert.deepEqual([appt.calendarName, appt.status, appt.contactId], ["P3 Discovery", "booked", A.contact]);

        const convos = (await appFetch(app, "/api/dashboard/conversations", { cookie: cookieA })).body.conversations as Record<string, any>[];
        const note = convos.find((c) => c.id === A.message)!;
        assert.deepEqual([note.direction, note.channel, note.summary, note.contactId], ["unknown", "sms", "Internal note", A.contact]);

        const events = (await appFetch(app, "/api/dashboard/events", { cookie: cookieA })).body.events as Record<string, any>[];
        assert.ok(events.some((e) => e.eventType === "lead.created" && e.entityRefs.contactId === A.contact && e.locationId === wsA),
          JSON.stringify(events));

        const { summary } = (await appFetch(app, "/api/dashboard/summary", { cookie: cookieA })).body;
        const oppRows = await list(ownerA.token, "opportunities?select=status,value_cents&deleted_at=is.null");
        assert.deepEqual(
          [summary.contactsCount, summary.opportunitiesCount, summary.wonCount, summary.openPipelineValue, summary.waitingForSync],
          [visible.length, oppRows.length, oppRows.filter((o) => o.status === "won").length,
            oppRows.filter((o) => o.status === "open").reduce((s, o) => s + Number(o.value_cents), 0) / 100, false]);
        assert.equal(summary.appointmentsCount, (await list(ownerA.token, "appointments?select=id")).length);
        assert.equal(summary.conversationEventsCount, (await list(ownerA.token, "messages?select=id")).length);
        assert.ok(summary.lastEventAt, "last activity is reported");
      });

      test("ISO: workspace B's owner never receives workspace A's records through the app's APIs or pages", async () => {
        for (const endpoint of DASHBOARD_ENDPOINTS) {
          const r = await appFetch(app, `/api/dashboard/${endpoint}`, { cookie: cookieB });
          assert.equal(r.status, 200, endpoint);
          for (const secret of [...seededA(), wsA, "P3 Ada", "P3 Discovery"]) {
            assert.equal(r.text.includes(secret), false, `${endpoint}: workspace A value ${secret} reached workspace B`);
          }
        }
        const contacts = (await appFetch(app, "/api/dashboard/contacts", { cookie: cookieB })).body.contacts as { id: string }[];
        assert.ok(contacts.some((c) => c.id === contactBOnly));
        for (const path of ["/dashboard", "/contacts", "/pipeline", "/calendar", "/tasks", "/reviews", "/reporting"]) {
          const page = await appFetch(app, path, { cookie: cookieB });
          assert.equal(page.status, 200, path);
          for (const secret of ["P3 Ada", "P3 Discovery", "P3 call back"]) {
            assert.equal(page.text.includes(secret), false, `${path}: workspace A value ${secret} rendered for workspace B`);
          }
        }
      });

      test("tenant config, public branding, health, and retired legacy endpoints", async () => {
        const [settings] = await list(ownerA.token, "workspace_settings?select=business_name");
        const config = await appFetch(app, "/api/tenant/config", { cookie: cookieA });
        assert.equal(config.status, 200, config.text);
        assert.equal(config.body.client.businessName, settings.business_name);
        assert.deepEqual(config.body.owner, { pipelineName: config.body.owner.pipelineName, stagesCount: 12 });
        const pub = await appFetch(app, "/api/tenant/public");
        assert.equal(pub.body.client.businessName, pub.body.platform.brandName, "public branding is the platform's only");
        const health = await appFetch(app, "/api/health");
        assert.deepEqual([health.status, health.body.ok, health.body.db, health.body.authProvider], [200, true, "ok", "supabase"]);
        for (const path of ["/api/ghl/health", "/api/sync/health", "/api/events", "/api/onboarding/readiness", "/api/leads", "/api/webhooks/ghl"]) {
          assert.equal((await appFetch(app, path, { cookie: cookieA })).status, 404, `${path} is retired (P7)`);
        }
        const webhook = await appFetch(app, "/api/webhooks/ghl", { method: "POST", body: "{}", contentType: "application/json" });
        assert.equal(webhook.status, 404, "webhook ingestion is retired (P7)");
      });

      test("UI-1: the owner gets 200 with no page errors on all 15 sidebar destinations plus support, training, privacy, and terms", async () => {
        const destinations = ["/dashboard", "/inbox", "/contacts", "/pipeline", "/calendar", "/tasks", "/automations", "/marketing",
          "/reviews", "/payments", "/reporting", "/settings", "/onboarding", "/help", "/library",
          "/support", "/training", "/privacy", "/terms"];
        for (const path of destinations) {
          const r = await appFetch(app, path, { cookie: cookieA });
          assert.equal(r.status, 200, `${path}: ${r.status}`);
          for (const marker of ["__next_error__", "Application error", "Internal Server Error", "This page could not be found"]) {
            assert.equal(r.text.includes(marker), false, `${path}: page error marker ${marker}`);
          }
          assert.equal(r.text.includes("Waiting for sync"), false, `${path}: legacy sync copy in native mode`);
        }
        const expectations: [string, string[]][] = [
          ["/dashboard", ["Needs Attention", "Recent Activity", "lead.created"]],
          ["/contacts", ["P3 Ada Native", "in this workspace"]],
          ["/pipeline", ["New Lead", "Won", "Long-Term Nurture"]],
          ["/calendar", ["P3 Discovery", "30 min"]],
          ["/tasks", ["P3 call back"]],
          ["/reviews", ["5/5"]],
        ];
        for (const [path, markers] of expectations) {
          const r = await appFetch(app, path, { cookie: cookieA });
          for (const m of markers) assert.ok(r.text.includes(m), `${path} should render "${m}"`);
        }
      });

      test("UI-1: native empty states, and Setup hidden for admins (Resources stays visible to them)", async () => {
        const tasksB = await appFetch(app, "/tasks", { cookie: cookieB });
        assert.equal(tasksB.status, 200);
        assert.ok(tasksB.text.includes("No tasks yet"), "native empty-state copy");
        const calendarB = await appFetch(app, "/calendar", { cookie: cookieB });
        assert.ok(calendarB.text.includes("No calendars yet"), "a workspace without calendars shows the native empty state");
        assert.ok(calendarB.text.includes("Create calendar"), "owners hold calendar.configure");

        const admin = await signUp(env, email("app-admin-a"), "App Admin A");
        const inv = await rpc(env, ownerA.token, "create_invitation", { p_email: admin.email, p_role: "admin", p_ttl_hours: 72 });
        assert.equal(inv.status, 200, inv.text);
        assert.equal((await rpc(env, admin.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
        const cookie = await appLogin(app, admin);
        const setup = pageRedirect(await appFetch(app, "/onboarding", { cookie }), "admin /onboarding",
          ["Configuration readiness", "Onboarding / Setup Checklist"]);
        assert.deepEqual([setup.pathname, setup.searchParams.get("denied")], ["/dashboard", "1"]);
        assert.equal((await appFetch(app, "/library", { cookie })).status, 200);
        assert.equal((await appFetch(app, "/contacts", { cookie })).status, 200);
      });
    });

    // P3 follow-up: pipeline columns and calendar cards are matched by id in the rendered pages.
    // A workspace of its own, so stage renames cannot affect other tests.
    describe("rendered pipeline and calendar pages match records by id (P3)", () => {
      let owner: Identity;
      let ws = "";
      let cookie = "";
      const stage: Record<number, string> = {};

      /** Every card in document order: its title and its HTML (React's text-node separators removed). */
      const cardsOf = (html: string) =>
        [...html.replace(/<!-- -->/g, "").matchAll(/<article class="card[^"]*">([\s\S]*?)<\/article>/g)].map((m) => ({
          title: m[1].match(/<h2 class="card-title">([\s\S]*?)<\/h2>/)?.[1] ?? "",
          html: m[1],
        }));
      const listItems = (html: string) => (html.match(/<li /g) ?? []).length;
      const boardOf = async () => {
        const page = await appFetch(app, "/pipeline", { cookie });
        assert.equal(page.status, 200);
        const cards = cardsOf(page.text);
        return { text: page.text, summary: cards.slice(0, 4), board: cards.slice(-12) };
      };
      const created = async (table: string, row: Record<string, unknown>) => {
        const r = await rest(env, owner.token, "POST", table, row);
        assert.equal(r.status, 201, `${table}: ${r.status} ${r.text}`);
        return r.body[0].id as string;
      };
      const rename = async (position: number, name: string) => {
        const r = await rest(env, owner.token, "PATCH", `pipeline_stages?id=eq.${stage[position]}`, { name });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.body.length, 1);
      };

      before(async () => {
        owner = await signUp(env, email("display-owner"), "Display Owner");
        const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
          p_provisioning_key: `synthetic-display-${run}`, p_name: "Display (synthetic)",
          p_slug: `display-synthetic-${run}`, p_owner_email: owner.email,
        });
        assert.equal(prov.status, 200, prov.text);
        ws = prov.body.workspace_id;
        assert.equal((await rpc(env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
        cookie = await appLogin(app, owner);
        const stages = await rest(env, owner.token, "GET", "pipeline_stages?select=id,position,pipeline_id&order=position");
        for (const s of stages.body) stage[s.position] = s.id;
        const pipelineId = stages.body[0].pipeline_id;

        // Overlapping ("New Lead" / "New Lead Follow-up") and duplicate ("Qualified" ×2) stage names.
        await rename(3, "New Lead Follow-up");
        await rename(8, "Qualified");
        const contact = await created("contacts", { workspace_id: ws, first_name: "Display", last_name: "Contact" });
        const opp = (position: number, title: string, value_cents: number) =>
          created("opportunities", { workspace_id: ws, contact_id: contact, pipeline_id: pipelineId,
            stage_id: stage[position], title, value_cents });
        await opp(3, "follow-up", 20050);
        await opp(8, "second qualified", 40000);
        await opp(8, "second qualified b", 1);
        await opp(10, "won", 99999);

        const discovery = await created("calendars", { workspace_id: ws, name: "Discovery Call", slug: `discovery-${run}`,
          duration_minutes: 30, is_primary: true });
        await created("calendars", { workspace_id: ws, name: "Discovery Follow-up", slug: `discovery-follow-up-${run}`,
          duration_minutes: 15 });
        const site = await created("calendars", { workspace_id: ws, name: "Site Visit", slug: `site-visit-${run}`,
          duration_minutes: 60 });
        await created("appointments", { workspace_id: ws, calendar_id: discovery, contact_id: contact,
          starts_at: "2031-05-06T14:00:00Z", ends_at: "2031-05-06T14:30:00Z" });
        await created("appointments", { workspace_id: ws, calendar_id: site, contact_id: contact,
          starts_at: "2031-05-07T16:00:00Z", ends_at: "2031-05-07T17:00:00Z" });
      });

      test("pipeline: duplicate and overlapping stage names never pull opportunities into the wrong column; counts and values are exact", async () => {
        const { text, summary, board } = await boardOf();
        assert.deepEqual(board.map((c) => c.title), ["New Lead", "Attempting Contact", "New Lead Follow-up", "Qualified",
          "Appointment Booked", "Appointment Completed", "Estimate / Proposal Sent", "Qualified", "Decision Pending",
          "Won", "Lost", "Long-Term Nurture"]);
        const items = board.map((c) => listItems(c.html));
        assert.deepEqual(items, [0, 0, 1, 0, 0, 0, 0, 2, 0, 1, 0, 0], "each opportunity rendered in exactly one column");
        for (const i of [0, 3]) assert.ok(board[i].html.includes("No opportunities yet"), `${board[i].title} stays empty`);
        assert.ok(board[2].html.includes("$200.5<"), "follow-up column value");
        assert.ok(board[7].html.includes("$400.01<"), "second Qualified column value (40000 + 1 cents)");
        assert.ok(board[9].html.includes("$999.99<"), "won column value");
        assert.ok(board[0].html.includes("$0<") && board[3].html.includes("$0<"));
        assert.deepEqual(summary.map((c) => [c.title, c.html.match(/>(\d+)<\/p>/)?.[1]]),
          [["New Lead", "0"], ["Attempting Contact", "0"], ["New Lead Follow-up", "1"], ["Qualified", "0"]]);
        assert.ok(summary[2].html.includes("$200.5 combined"));
        assert.ok(text.includes("4 opportunities across 12 stage(s)"), "banner counts each opportunity once");
      });

      test("pipeline: renaming a stage keeps its opportunities in the same column under the new name", async () => {
        await rename(8, "Second Look");
        const { board } = await boardOf();
        assert.equal(board[7].title, "Second Look");
        assert.equal(listItems(board[7].html), 2);
        assert.ok(board[7].html.includes("$400.01<"));
        assert.equal(board.filter((c) => c.title === "Qualified").length, 1);
        assert.ok(board[3].html.includes("No opportunities yet"));
        const api = await appFetch(app, "/api/dashboard/opportunities", { cookie });
        const names = (api.body.opportunities as { stageName: string }[]).map((o) => o.stageName).sort();
        assert.deepEqual(names, ["New Lead Follow-up", "Second Look", "Second Look", "Won"]);
      });

      test("calendars: each card lists only its own bookings; an empty calendar with a similar name stays empty", async () => {
        const page = await appFetch(app, "/calendar", { cookie });
        assert.equal(page.status, 200);
        const cards = new Map(cardsOf(page.text).map((c) => [c.title, c.html]));
        const discovery = cards.get("Discovery Call")!;
        const followUp = cards.get("Discovery Follow-up")!;
        const site = cards.get("Site Visit")!;
        assert.ok(discovery && followUp && site, [...cards.keys()].join(", "));
        assert.ok(discovery.includes("2031-05-06 14:00") && !discovery.includes("2031-05-07"));
        assert.ok(site.includes("2031-05-07 16:00") && !site.includes("2031-05-06"));
        assert.ok(followUp.includes("No appointments scheduled"), "empty calendar shows its empty state");
        assert.equal(listItems(followUp), 0, "no fallback to another calendar's bookings");
        assert.ok(page.text.includes("2 appointment(s)"));
      });
    });

    describe("team, invitations, and settings through the app (P4)", () => {
      let owner: Identity;
      let admin: Identity;
      let emp: Identity;
      let ws = "";
      let ownerCookie = "";
      let adminCookie = "";
      let empCookie = "";

      type Member = { userId: string; email: string; role: string; overrides: Record<string, boolean> };
      const invite = (cookie: string, json: unknown) => appFetch(app, "/api/team/invitations", { method: "POST", cookie, json });
      const tokenOf = (url: unknown) => {
        const m = /^http:\/\/127\.0\.0\.1:\d+\/invite\/([0-9a-f]{64})$/.exec(String(url));
        assert.ok(m, `invite link: ${String(url)}`);
        return m![1];
      };
      const accept = (token: string, cookie?: string, json: unknown = {}) =>
        appFetch(app, `/api/invitations/${token}/accept`, { method: "POST", cookie, json });
      const team = async (cookie: string): Promise<Member[]> => {
        const r = await appFetch(app, "/api/team", { cookie });
        assert.equal(r.status, 200, r.text);
        return r.body.members;
      };
      const roleOf = async (userId: string) =>
        (await db.query<{ role: string; status: string }>(
          "select role, status from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, userId])).rows[0];
      const audit = async (cookie: string) => {
        const r = await appFetch(app, "/api/audit?limit=100", { cookie });
        assert.equal(r.status, 200, r.text);
        return r.body.items as { action: string; target: string | null; actorId: string | null; actorKind: string; metadata: any }[];
      };
      const expect = (r: Awaited<ReturnType<typeof appFetch>>, status: number, code: string | null, label: string) =>
        assert.deepEqual([r.status, code === null ? null : r.body?.code], [status, code], `${label}: ${r.text.slice(0, 200)}`);
      const joinAs = async (user: Identity, role: "admin" | "employee") => {
        const r = await invite(ownerCookie, { email: user.email, role });
        assert.equal(r.status, 200, r.text);
        const cookie = await appLogin(app, user);
        const a = await accept(tokenOf(r.body.inviteUrl), cookie);
        assert.equal(a.status, 200, a.text);
        assert.equal(a.body.workspace?.id, ws, "acceptance answers with the joined workspace");
        return cookie;
      };

      before(async () => {
        owner = await signUp(env, email("team-owner"), "Team Owner");
        admin = await signUp(env, email("team-admin"), "Team Admin");
        emp = await signUp(env, email("team-employee"), "Team Employee");
        const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
          p_provisioning_key: `synthetic-team-${run}`, p_name: "Team (synthetic)", p_slug: `team-synthetic-${run}`,
          p_owner_email: owner.email,
        });
        assert.equal(prov.status, 200, prov.text);
        ws = prov.body.workspace_id;
        assert.equal((await rpc(env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
        ownerCookie = await appLogin(app, owner);
        adminCookie = await joinAs(admin, "admin");
        empCookie = await joinAs(emp, "employee");
      });

      test("INV-1/2/6/7: an invite link is returned once, only its hash is stored, and nothing is sent", async () => {
        const mailBefore = env.mailUrl ? await capturedMailCount(env) : null;
        assert.deepEqual(messageRoutes(stack.project).filter((r) => r !== "local_smtp"), [], "no SMTP or SMS route");
        const newcomer = email("team-newcomer");
        const r = await invite(ownerCookie, { email: `  ${newcomer.toUpperCase()} `, role: "employee", workspaceId: wsA });
        assert.equal(r.status, 200, r.text);
        const token = tokenOf(r.body.inviteUrl);
        assert.equal(r.text.split(token).length, 2, "the token appears exactly once (inside the link)");
        assert.deepEqual({ ...r.body.invitation, id: undefined, createdAt: undefined, expiresAt: undefined },
          { id: undefined, email: newcomer, role: "employee", createdAt: undefined, expiresAt: undefined, status: "pending" });
        assert.match(r.headers.get("cache-control") ?? "", /no-store/);

        const stored = await db.query<{ workspace_id: string; hashed: boolean; row: string }>(
          `select workspace_id, token_hash = private.hash_token($2) hashed, row_to_json(i)::text "row"
           from public.workspace_invitations i where id = $1`, [r.body.invitation.id, token]);
        assert.equal(stored.rows[0].workspace_id, ws, "a body workspaceId is ignored: the invitation is for the active workspace");
        assert.equal(stored.rows[0].hashed, true);
        assert.equal(stored.rows[0].row.includes(token), false, "the raw token is not stored");

        const list = await appFetch(app, "/api/team/invitations", { cookie: ownerCookie });
        assert.equal(list.status, 200, list.text);
        assert.equal(list.text.includes(token), false, "listing never shows the token again");
        assert.equal(list.text.includes("token_hash"), false);
        const item = list.body.items.find((i: { id: string }) => i.id === r.body.invitation.id);
        assert.equal(item?.status, "pending");
        const hash = await rest(env, owner.token, "GET", `workspace_invitations?select=token_hash&id=eq.${r.body.invitation.id}`);
        assert.ok(denied(hash.status), `token_hash readable through PostgREST: ${hash.status}`);

        expect(await invite(ownerCookie, { email: newcomer, role: "employee" }), 409, "conflict", "second open invitation");
        expect(await invite(ownerCookie, { email: emp.email, role: "employee" }), 409, "already_member", "existing member");
        for (const body of [{ email: "not-an-email", role: "employee" }, { email: newcomer, role: "platform_admin" },
          { email: newcomer, role: "employee", ttlHours: 169 }, { email: newcomer, role: "employee", ttlHours: 0 },
          { email: newcomer, role: "employee", extra: true }, { role: "employee" }]) {
          const bad = await invite(ownerCookie, body);
          expect(bad, 422, "validation_failed", JSON.stringify(body));
          assert.equal(typeof bad.body.fields, "object");
        }
        if (mailBefore !== null) assert.equal(await capturedMailCount(env), mailBefore, "creating invitations sends no email");
      });

      test("INV: the public preview reveals only a masked email; a new account is created from the invitation (A1)", async () => {
        const newcomer = email("team-signup");
        const r = await invite(ownerCookie, { email: newcomer, role: "employee" });
        const token = tokenOf(r.body.inviteUrl);
        const preview = await appFetch(app, `/api/invitations/${token}`);
        assert.equal(preview.status, 200, preview.text);
        assert.deepEqual({ ...preview.body, emailMasked: undefined },
          { ok: true, workspaceName: "Team (synthetic)", role: "employee", emailMasked: undefined, accountExists: false });
        assert.equal(preview.text.includes(newcomer), false, "the full email is not revealed");
        assert.equal(preview.text.includes(ws), false, "the workspace id is not revealed");
        assert.equal(preview.headers.get("referrer-policy"), "no-referrer");
        expect(await appFetch(app, `/api/invitations/${"0".repeat(64)}`), 404, "invitation_not_found", "unknown token");
        expect(await appFetch(app, "/api/invitations/not-a-token"), 404, "invitation_not_found", "malformed token");

        expect(await accept(token), 401, "unauthenticated", "no session and no password");
        expect(await accept(token, undefined, { password: "short" }), 422, "validation_failed", "short password");
        expect(await accept(token, undefined, { password: "Long-enough-pass-1", email: outsider.email }), 422,
          "validation_failed", "client-chosen email");
        assert.equal((await db.query("select 1 from auth.users where email = $1", [newcomer])).rowCount, 0, "no account yet");

        const joined = await accept(token, undefined, { password: "Local-newcomer-pass-1" });
        assert.equal(joined.status, 200, joined.text);
        assert.equal(joined.body.workspace?.id, ws);
        const cookie = cookieHeader(joined.setCookies);
        const me = await appFetch(app, "/api/auth/me", { cookie });
        assert.deepEqual([me.body.user?.email, me.body.role, me.body.workspace?.id], [newcomer, "employee", ws]);
        const created = await db.query<{ email: string; confirmed: boolean }>(
          "select email, email_confirmed_at is not null confirmed from auth.users where email = $1", [newcomer]);
        assert.deepEqual(created.rows, [{ email: newcomer, confirmed: true }], "the account uses the invited address");

        expect(await accept(token, undefined, { password: "Local-newcomer-pass-2" }), 410, "invitation_used", "reuse without session");
        expect(await accept(token, cookie), 410, "invitation_used", "reuse with session");
        expect(await appFetch(app, `/api/invitations/${token}`), 410, "invitation_used", "preview after use");
        const accepted = await audit(ownerCookie);
        assert.ok(accepted.some((a) => a.action === "invitation.accepted" && a.actorId === me.body.user.id), "acceptance is audited");
      });

      test("INV-3/4: expired, revoked, mismatched, and concurrent acceptances are refused exactly once", async () => {
        const existing = await signUp(env, email("team-existing"), "Team Existing");
        const existingCookie = await appLogin(app, existing);

        const exp = await invite(ownerCookie, { email: email("team-expired"), role: "employee" });
        await db.query(`update public.workspace_invitations set created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 second' where id = $1`, [exp.body.invitation.id]);
        const expToken = tokenOf(exp.body.inviteUrl);
        expect(await appFetch(app, `/api/invitations/${expToken}`), 410, "invitation_expired", "expired preview");
        expect(await accept(expToken, undefined, { password: "Local-expired-pass-1" }), 410, "invitation_expired", "expired accept");

        const rev = await invite(ownerCookie, { email: email("team-revoked"), role: "employee" });
        const revoked = await appFetch(app, `/api/team/invitations/${rev.body.invitation.id}`, { method: "DELETE", cookie: ownerCookie });
        assert.equal(revoked.status, 200, revoked.text);
        expect(await appFetch(app, `/api/team/invitations/${rev.body.invitation.id}`, { method: "DELETE", cookie: ownerCookie }),
          409, "conflict", "revoking twice");
        const revToken = tokenOf(rev.body.inviteUrl);
        expect(await appFetch(app, `/api/invitations/${revToken}`), 410, "invitation_revoked", "revoked preview");
        expect(await accept(revToken, undefined, { password: "Local-revoked-pass-1" }), 410, "invitation_revoked", "revoked accept");

        const foreign = await rpc(env, ownerA.token, "create_invitation", { p_email: email("team-foreign"), p_role: "employee", p_ttl_hours: 24 });
        assert.equal(foreign.status, 200, foreign.text);
        expect(await appFetch(app, `/api/team/invitations/${foreign.body.invitation_id}`, { method: "DELETE", cookie: ownerCookie }),
          404, "not_found", "another workspace's invitation");
        assert.equal((await db.query("select revoked_at from public.workspace_invitations where id = $1",
          [foreign.body.invitation_id])).rows[0].revoked_at, null);
        expect(await appFetch(app, "/api/team/invitations/not-a-uuid", { method: "DELETE", cookie: ownerCookie }),
          422, "validation_failed", "malformed id");

        const mismatch = await invite(ownerCookie, { email: email("team-someone-else"), role: "employee" });
        const misToken = tokenOf(mismatch.body.inviteUrl);
        expect(await accept(misToken, existingCookie), 403, "invitation_email_mismatch", "signed in as another address");
        assert.equal((await appFetch(app, `/api/invitations/${misToken}`)).status, 200, "a mismatch does not consume the invitation");

        const forExisting = await invite(ownerCookie, { email: existing.email, role: "employee" });
        const exToken = tokenOf(forExisting.body.inviteUrl);
        const preview = await appFetch(app, `/api/invitations/${exToken}`);
        assert.equal(preview.body.accountExists, true);
        expect(await accept(exToken, undefined, { password: "Local-existing-pass-1" }), 409, "account_exists",
          "an existing account must sign in");
        const results = await Promise.all([accept(exToken, existingCookie), accept(exToken, existingCookie)]);
        assert.deepEqual(results.map((x) => x.status).sort(), [200, 410], results.map((x) => x.text).join(" | "));
        const rows = await db.query("select role, status from public.workspace_members where workspace_id = $1 and user_id = $2",
          [ws, existing.id]);
        assert.deepEqual(rows.rows, [{ role: "employee", status: "active" }], "exactly one membership");
      });

      test("ROLE-1..8: role authority, self changes, foreign ids, and audit through /api/team", async () => {
        const members = await team(empCookie);
        assert.ok(members.some((m) => m.userId === owner.id && m.email === owner.email && m.role === "owner"));
        expect(await appFetch(app, "/api/team", { cookie: await appLogin(app, outsider) }), 403, "no_active_workspace", "outsider");
        expect(await appFetch(app, "/api/team"), 401, "unauthenticated", "anonymous");

        const patch = (cookie: string, userId: string, json: unknown) =>
          appFetch(app, `/api/team/${userId}`, { method: "PATCH", cookie, json });
        const remove = (cookie: string, userId: string) => appFetch(app, `/api/team/${userId}`, { method: "DELETE", cookie });

        // Employees: no team changes at all.
        expect(await patch(empCookie, admin.id, { role: "employee" }), 403, "forbidden", "employee changes a role");
        expect(await remove(empCookie, admin.id), 403, "forbidden", "employee removes");
        expect(await invite(empCookie, { email: email("team-by-employee"), role: "employee" }), 403, "forbidden", "employee invites");
        // Admins: employees only; no role changes.
        expect(await invite(adminCookie, { email: email("team-admin-invite"), role: "admin" }), 403, "forbidden", "admin invites admin");
        assert.equal((await invite(adminCookie, { email: email("team-admin-invite"), role: "employee" })).status, 200);
        expect(await patch(adminCookie, emp.id, { role: "admin" }), 403, "forbidden", "admin promotes");
        expect(await remove(adminCookie, owner.id), 403, "forbidden", "admin removes the owner");
        assert.deepEqual(await roleOf(owner.id), { role: "owner", status: "active" });
        // Overrides: employees only, never team.* or integrations.manage; atomic.
        const ov = await patch(adminCookie, emp.id, { overrides: { "contacts.delete": true } });
        assert.equal(ov.status, 200, ov.text);
        assert.deepEqual(ov.body.member.overrides, { "contacts.delete": true });
        const empMe = await appFetch(app, "/api/auth/me", { cookie: empCookie });
        assert.ok(empMe.body.permissions.includes("contacts.delete"), "the override takes effect on the next request");
        expect(await patch(adminCookie, emp.id, { overrides: { "contacts.write": false, "team.remove": true } }), 422,
          "validation_failed", "granting team.remove");
        assert.deepEqual((await team(ownerCookie)).find((m) => m.userId === emp.id)?.overrides, { "contacts.delete": true },
          "a refused batch changes nothing");
        expect(await patch(ownerCookie, admin.id, { overrides: { "contacts.delete": true } }), 422, "validation_failed",
          "overrides on an admin");
        for (const body of [{}, { role: "superuser" }, { role: "admin", overrides: {} }, { overrides: {} },
          { overrides: { "contacts.delete": "yes" } }, { overrides: { "not a permission": true } }]) {
          expect(await patch(ownerCookie, emp.id, body), 422, "validation_failed", JSON.stringify(body));
        }
        // Owners: everything except themselves.
        expect(await patch(ownerCookie, owner.id, { role: "admin" }), 403, "forbidden", "self role change");
        expect(await remove(ownerCookie, owner.id), 403, "forbidden", "self removal");
        const promoted = await patch(ownerCookie, emp.id, { role: "admin" });
        assert.equal(promoted.status, 200, promoted.text);
        assert.deepEqual([promoted.body.member.role, promoted.body.member.overrides], ["admin", {}], "overrides cleared on promotion");
        assert.equal((await patch(ownerCookie, emp.id, { role: "employee" })).status, 200);
        const changes = (await audit(ownerCookie)).filter((a) => a.action === "member.role_changed" && a.target === emp.id);
        assert.ok(changes.length >= 2, "role changes are audited");
        assert.equal(changes[0].actorId, owner.id);
        // Foreign and unknown ids answer 404 and change nothing.
        for (const id of [ownerA.id, employeeA.id, "00000000-0000-4000-8000-000000000000"]) {
          expect(await patch(ownerCookie, id, { role: "employee" }), 404, "not_found", `patch ${id}`);
          expect(await remove(ownerCookie, id), 404, "not_found", `remove ${id}`);
        }
        expect(await patch(ownerCookie, "not-a-uuid", { role: "employee" }), 422, "validation_failed", "malformed id");
        const ownerBCookie = await appLogin(app, ownerB);
        expect(await patch(ownerBCookie, emp.id, { role: "admin" }), 404, "not_found", "another workspace's owner");
        assert.deepEqual(await roleOf(emp.id), { role: "employee", status: "active" });
        assert.equal((await db.query("select count(*)::int n from public.workspace_members where workspace_id = $1 and user_id = $2",
          [wsA, ownerA.id])).rows[0].n, 1, "ownerA's membership in A is untouched");
      });

      test("ROLE-7 and MEM-1/2/4: platform grants cannot manage members; removal revokes access and unassigns work", async () => {
        const grant = await grantAccess(ws, "write", "P4 stack team management check");
        assert.equal(grant.status, 200, grant.text);
        const byPlatform = await rpc(env, platformAal2, "set_member_role", { p_user_id: emp.id, p_role: "admin" });
        assert.ok(byPlatform.status >= 400 && /forbidden/.test(byPlatform.text), byPlatform.text);
        const invByPlatform = await rpc(env, platformAal2, "create_invitation", { p_email: email("team-by-platform"), p_role: "owner", p_ttl_hours: 24 });
        assert.ok(invByPlatform.status >= 400 && /forbidden/.test(invByPlatform.text), invByPlatform.text);
        await revokeGrant(grant.body.id);

        const contact = await rest(env, owner.token, "POST", "contacts", { workspace_id: ws, first_name: "Removal", owner_user_id: emp.id });
        assert.equal(contact.status, 201, contact.text);
        const task = await rest(env, owner.token, "POST", "tasks", { workspace_id: ws, title: "Follow up", assigned_user_id: emp.id });
        assert.equal(task.status, 201, task.text);

        const removed = await appFetch(app, `/api/team/${emp.id}`, { method: "DELETE", cookie: adminCookie });
        assert.equal(removed.status, 200, removed.text);
        expect(await appFetch(app, "/api/team", { cookie: empCookie }), 403, "no_active_workspace", "removed member's session");
        const after = await db.query<{ task: string | null; owner: string | null }>(
          `select (select assigned_user_id from public.tasks where id = $1) task,
                  (select owner_user_id from public.contacts where id = $2) owner`, [task.body[0].id, contact.body[0].id]);
        assert.deepEqual(after.rows[0], { task: null, owner: null }, "open work is unassigned");
        assert.ok((await audit(ownerCookie)).some((a) => a.action === "member.removed" && a.target === emp.id && a.actorId === admin.id));
        expect(await appFetch(app, `/api/team/${emp.id}`, { method: "DELETE", cookie: ownerCookie }), 404, "not_found", "removing twice");

        const again = await invite(ownerCookie, { email: emp.email, role: "employee" });
        assert.equal(again.status, 200, again.text);
        assert.equal((await accept(tokenOf(again.body.inviteUrl), empCookie)).status, 200);
        const rows = await db.query("select role, status from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, emp.id]);
        assert.deepEqual(rows.rows, [{ role: "employee", status: "active" }], "re-invitation reactivates the same membership");
        assert.equal((await appFetch(app, "/api/team", { cookie: empCookie })).status, 200);
      });

      test("SUSP: a suspended workspace refuses acceptance and team APIs until reactivated", async () => {
        const pending = await invite(ownerCookie, { email: email("team-suspended"), role: "employee" });
        const token = tokenOf(pending.body.inviteUrl);
        await voidRpc(platformAal2, "platform_suspend_workspace", { p_workspace_id: ws, p_reason: "P4 suspension check" });
        let reactivated = false;
        try {
          expect(await accept(token, undefined, { password: "Local-suspended-pass-1" }), 423, "workspace_suspended", "accept");
          assert.equal((await db.query("select 1 from auth.users where email = $1", [email("team-suspended")])).rowCount, 0,
            "no account is created for a suspended workspace");
          expect(await appFetch(app, "/api/team", { cookie: ownerCookie }), 423, "workspace_suspended", "team list");
          expect(await invite(ownerCookie, { email: email("team-suspended-2"), role: "employee" }), 423, "workspace_suspended", "invite");
          expect(await appFetch(app, "/api/settings/workspace", { method: "PATCH", cookie: ownerCookie, json: { industry: "Towing" } }),
            423, "workspace_suspended", "settings");
          await voidRpc(platformAal2, "platform_reactivate_workspace", { p_workspace_id: ws, p_reason: "P4 suspension check done" });
          reactivated = true;
          assert.equal((await appFetch(app, "/api/team", { cookie: ownerCookie })).status, 200);
        } finally {
          if (!reactivated) await rpc(env, platformAal2, "platform_reactivate_workspace", { p_workspace_id: ws, p_reason: "P4 cleanup" });
        }
      });

      test("SET-1..4: workspace settings follow settings.read/write, ignore client workspace ids, and are attributed", async () => {
        const before = await db.query("select business_name from public.workspace_settings where workspace_id = $1", [wsA]);
        const read = await appFetch(app, "/api/settings/workspace", { cookie: empCookie });
        assert.equal(read.status, 200, read.text);
        assert.equal(read.body.settings.businessName, "Team (synthetic)");
        expect(await appFetch(app, "/api/settings/workspace", { method: "PATCH", cookie: empCookie, json: { industry: "x" } }),
          403, "forbidden", "employee edits settings");

        const patch = (json: unknown, cookie = ownerCookie) =>
          appFetch(app, "/api/settings/workspace", { method: "PATCH", cookie, json });
        const ok = await patch({ businessName: "Team Towing", supportEmail: "Help@Example.test", websiteUrl: "https://example.test",
          businessHours: { mon: [{ start: "08:00", end: "17:00" }] }, workspaceId: wsA });
        assert.equal(ok.status, 200, ok.text);
        assert.deepEqual([ok.body.settings.businessName, ok.body.settings.supportEmail, ok.body.settings.businessHours],
          ["Team Towing", "help@example.test", { mon: [{ start: "08:00", end: "17:00" }] }]);
        assert.deepEqual((await db.query("select business_name from public.workspace_settings where workspace_id = $1", [wsA])).rows,
          before.rows, "workspace A is untouched");
        for (const body of [{}, { businessName: "" }, { timezone: "Mars/Olympus" }, { websiteUrl: "javascript:alert(1)" },
          { supportEmail: "nope" }, { brandColors: { primary: "red" } }, { businessHours: { mon: [{ start: "18:00", end: "09:00" }] } },
          { logoPath: "x.png" }, { businessPhone: "call me" }]) {
          expect(await patch(body), 422, "validation_failed", JSON.stringify(body));
        }
        const attributed = await db.query<{ updated_by: string }>("select updated_by from public.workspace_settings where workspace_id = $1", [ws]);
        assert.equal(attributed.rows[0].updated_by, owner.id, "the database stamps the editor");
        const entry = (await audit(ownerCookie)).find((a) => a.action === "settings.updated");
        assert.ok(entry, "the change is audited");
        assert.deepEqual([...entry!.metadata.fields].sort(), ["business_hours", "business_name", "support_email", "website_url"]);
        assert.equal(JSON.stringify(entry!.metadata).includes("help@example.test"), false, "values are not copied into the audit log");
        expect(await appFetch(app, "/api/audit", { cookie: empCookie }), 403, "forbidden", "employee reads audit");
        expect(await appFetch(app, "/api/audit?cursor=bad", { cookie: ownerCookie }), 422, "validation_failed", "bad cursor");
        expect(await appFetch(app, "/api/audit?limit=500", { cookie: ownerCookie }), 422, "validation_failed", "limit too large");
        const page1 = await appFetch(app, "/api/audit?limit=2", { cookie: ownerCookie });
        const page2 = await appFetch(app, `/api/audit?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`, { cookie: ownerCookie });
        assert.equal(page2.status, 200, page2.text);
        assert.ok(page2.body.items[0].id < page1.body.items[1].id, "keyset pages do not overlap");
      });

      test("SET-5..7: AI receptionist settings stay disabled; integrations hide secrets; the checklist reflects real records", async () => {
        const put = (json: unknown, cookie = adminCookie) => appFetch(app, "/api/settings/ai-receptionist", { method: "PUT", cookie, json });
        const ok = await put({ greeting: "Thanks for calling Team Towing.", businessHoursMode: "always", escalationUserId: admin.id });
        assert.equal(ok.status, 200, ok.text);
        assert.deepEqual([ok.body.config.enabled, ok.body.config.runtimeAvailable, ok.body.config.escalationUserId], [false, false, admin.id]);
        expect(await put({ enabled: true }), 422, "validation_failed", "enabling");
        expect(await put({ escalationUserId: employeeA.id }), 422, "validation_failed", "escalation to another workspace's member");
        expect(await put({ escalationUserId: outsider.id }), 422, "validation_failed", "escalation to a non-member");
        expect(await put({ greeting: "x".repeat(2001) }), 422, "validation_failed", "greeting too long");
        expect(await put({ apiKey: "sk-test" }), 422, "validation_failed", "unknown field");
        expect(await put({ greeting: "Hi" }, empCookie), 403, "forbidden", "employee edits AI settings");
        const enabled = await db.query("select enabled from public.ai_receptionist_configs where workspace_id = $1", [ws]);
        assert.deepEqual(enabled.rows, [{ enabled: false }]);
        const direct = await rest(env, owner.token, "PATCH", `ai_receptionist_configs?workspace_id=eq.${ws}`, { enabled: true });
        assert.notEqual(direct.status, 200, "enabling through PostgREST is refused too");
        assert.ok((await audit(ownerCookie)).some((a) => a.action === "ai_receptionist.updated" && a.actorId === admin.id));

        await db.query(`insert into public.integrations (workspace_id, provider, status, verified_at, capabilities, config)
          values ($1, 'twilio', 'connected', now(), '{sms}', '{"from":"+15550100","api_key":"sk-not-real","authToken":"not-real"}')`, [ws]);
        const integrations = await appFetch(app, "/api/integrations", { cookie: ownerCookie });
        assert.equal(integrations.status, 200, integrations.text);
        assert.equal(integrations.body.items.length, 1);
        assert.equal(integrations.body.items[0].status, "connected");
        assert.equal(/sk-not-real|not-real|api_key|authToken/.test(integrations.text), false, "no secret-like config is returned");
        expect(await appFetch(app, "/api/integrations", { cookie: empCookie }), 403, "forbidden", "employee lists integrations");
        const forged = await rest(env, owner.token, "PATCH", `integrations?workspace_id=eq.${ws}`, { status: "error" });
        assert.ok(denied(forged.status) || forged.status === 400, `clients cannot set integration status: ${forged.status}`);

        const checklist = await appFetch(app, "/api/onboarding/checklist", { cookie: ownerCookie });
        assert.equal(checklist.status, 200, checklist.text);
        assert.deepEqual(checklist.body.items, [{ key: "profile", done: true }, { key: "team", done: true },
          { key: "calendar", done: false }, { key: "ai_config", done: true }]);
        expect(await appFetch(app, "/api/onboarding/checklist", { cookie: adminCookie }), 403, "forbidden", "admins lack onboarding.read");
        const onboarding = await appFetch(app, "/onboarding", { cookie: ownerCookie });
        assert.equal(onboarding.status, 200);
      });

      test("browser: the owner invites, the invitee creates an account from the link, and the owner manages the team", async () => {
        const shots = mkdtempSync(join(tmpdir(), "fna-p4-browser-"));
        // Next rewrites a 127.0.0.1 host to localhost in redirects (NextURL), and session cookies are
        // host-only, so the browser uses localhost throughout.
        const base = app.url.replace("//127.0.0.1:", "//localhost:");
        const browser = await launchBrowser();
        try {
          const ownerCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
          ownerCtx.setDefaultTimeout(20_000);
          await ownerCtx.addInitScript("window.__name = (f) => f");
          const page = await ownerCtx.newPage();
          await page.goto(`${base}/login`);
          await page.fill("#email", owner.email);
          await page.fill("#password", owner.password);
          await page.click("button[type=submit]");
          await page.waitForURL(/\/dashboard$/);
          await page.goto(`${base}/settings`);
          await page.getByRole("heading", { name: "Team / Staff" }).waitFor();
          await page.getByText(admin.email, { exact: true }).waitFor();

          const invitee = email("team-browser");
          await page.fill("#invite-email", invitee);
          await page.selectOption("#invite-role", "employee");
          await page.getByRole("button", { name: "Create invite link" }).click();
          const link = page.getByLabel("Invite link");
          await link.waitFor();
          const url = await link.inputValue();
          assert.ok(url.startsWith(`${base}/invite/`) && /\/invite\/[0-9a-f]{64}$/.test(url), `the link uses the inviter's own address: ${url}`);
          await page.getByText("no email or text message is sent").waitFor();
          await page.screenshot({ path: join(shots, "settings-invite.png"), fullPage: true });
          await page.reload();
          await page.getByRole("heading", { name: "Team / Staff" }).waitFor();
          await page.getByText(invitee, { exact: true }).waitFor();
          assert.equal(await page.getByLabel("Invite link").count(), 0, "the link is not shown again after reload");

          const guestCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
          guestCtx.setDefaultTimeout(20_000);
          await guestCtx.addInitScript("window.__name = (f) => f");
          const guest = await guestCtx.newPage();
          await guest.goto(url);
          await guest.getByRole("heading", { name: "Join Team (synthetic)" }).waitFor();
          await guest.screenshot({ path: join(shots, "invite-landing.png"), fullPage: true });
          await guest.fill("#invite-password", "Local-browser-pass-1");
          await guest.fill("#invite-confirm", "Local-browser-pass-2");
          await guest.getByRole("button", { name: "Create account and join" }).click();
          await guest.getByText("The passwords do not match.").waitFor();
          await guest.fill("#invite-confirm", "Local-browser-pass-1");
          await guest.getByRole("button", { name: "Create account and join" }).click();
          await guest.waitForURL(/\/dashboard$/);
          await guest.goto(`${base}/settings`);
          await guest.getByText("Employee (you)").waitFor();
          assert.equal(await guest.locator("#invite-email").count(), 0, "employees get no invite form");
          assert.equal(await guest.locator("#biz-name").isDisabled(), true, "employees cannot edit the profile");
          await guest.screenshot({ path: join(shots, "settings-employee.png"), fullPage: true });

          await page.reload();
          await page.getByLabel(`Role for ${invitee}`).selectOption("admin");
          await page.getByText(/is now Admin\./).waitFor();
          assert.equal((await db.query<{ role: string }>(
            "select m.role from public.workspace_members m join auth.users u on u.id = m.user_id where m.workspace_id = $1 and u.email = $2",
            [ws, invitee])).rows[0].role, "admin");
          await page.getByRole("button", { name: `Remove ${invitee}` }).click();
          await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
          await page.getByText(/was removed from the workspace\./).waitFor();
          await guest.goto(`${base}/dashboard`);
          await guest.waitForURL(/\/no-access$/);

          await page.fill("#biz-businessPhone", "781-964-0654");
          await page.getByRole("button", { name: "Save profile" }).click();
          await page.getByText("Business profile saved.").waitFor();
          await page.fill("#ai-greeting", "Hello from the browser test.");
          await page.getByRole("button", { name: "Save AI settings" }).click();
          await page.getByText("AI receptionist settings saved. It stays off.").waitFor();
          await page.reload();
          await page.getByRole("heading", { name: "Recent changes" }).waitFor();
          assert.equal(await page.locator("#biz-businessPhone").inputValue(), "781-964-0654");
          await page.screenshot({ path: join(shots, "settings-owner.png"), fullPage: true });

          const revokedInvite = await invite(ownerCookie, { email: email("team-browser-revoked"), role: "employee" });
          await page.reload();
          await page.getByRole("button", { name: `Revoke invitation for ${email("team-browser-revoked")}` }).click();
          await page.getByText("Invitation revoked.").waitFor();
          await guest.goto(revokedInvite.body.inviteUrl);
          await guest.getByRole("heading", { name: "Invitation unavailable" }).waitFor();
          await guest.screenshot({ path: join(shots, "invite-revoked.png"), fullPage: true });
          console.log(`P4 browser screenshots: ${shots}`);
        } catch (err) {
          let n = 0;
          for (const ctx of browser.contexts()) {
            for (const p of ctx.pages()) {
              console.error(`P4 browser page ${n}: ${p.url()}`);
              await p.screenshot({ path: join(shots, `failure-${n++}.png`), fullPage: true }).catch(() => undefined);
            }
          }
          console.error(`P4 browser flow failed (screenshots so far: ${shots}):`, err);
          throw err;
        } finally {
          await browser.close().catch(() => undefined);
        }
      });
    });

    describe("native records through the app (P5)", () => {
      let owner: Identity;
      let emp: Identity;
      let leaver: Identity;
      let ws = "";
      let ownerCookie = "";
      let empCookie = "";
      const stages: Record<string, string> = {};
      let pipelineId = "";

      type R = Awaited<ReturnType<typeof appFetch>>;
      const expect = (r: R, status: number, code: string | null, label: string) =>
        assert.deepEqual([r.status, code === null ? null : r.body?.code], [status, code], `${label}: ${r.text.slice(0, 240)}`);
      const call = (cookie: string, method: string, path: string, json?: unknown) => appFetch(app, path, { method, cookie, json });
      const joinWs = async (user: Identity, role: "admin" | "employee") => {
        const inv = await rpc(env, owner.token, "create_invitation", { p_email: user.email, p_role: role, p_ttl_hours: 24 });
        assert.equal(inv.status, 200, inv.text);
        assert.equal((await rpc(env, user.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
      };
      const newContact = async (cookie: string, json: Record<string, unknown>) => {
        const r = await call(cookie, "POST", "/api/contacts", json);
        assert.equal(r.status, 200, r.text);
        return r.body.contact as { id: string; name: string };
      };
      const activity = async (entityId: string) =>
        (await db.query<{ action: string; actor_id: string; payload: any }>(
          "select action, actor_id, payload from public.activity_events where entity_id = $1 order by id", [entityId])).rows;

      before(async () => {
        owner = await signUp(env, email("crm-owner"), "CRM Owner");
        emp = await signUp(env, email("crm-employee"), "CRM Employee");
        leaver = await signUp(env, email("crm-leaver"), "CRM Leaver");
        const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
          p_provisioning_key: `synthetic-crm-${run}`, p_name: "CRM (synthetic)", p_slug: `crm-synthetic-${run}`, p_owner_email: owner.email,
        });
        assert.equal(prov.status, 200, prov.text);
        ws = prov.body.workspace_id;
        assert.equal((await rpc(env, owner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
        await joinWs(emp, "employee");
        await joinWs(leaver, "employee");
        ownerCookie = await appLogin(app, owner);
        empCookie = await appLogin(app, emp);
        const p = await call(ownerCookie, "GET", "/api/pipeline");
        assert.equal(p.status, 200, p.text);
        pipelineId = p.body.pipeline.id;
        for (const s of p.body.pipeline.stages) stages[s.name] = s.id;
        assert.equal(Object.keys(stages).length, 12);
      });

      test("CRUD-1 contacts: create, edit, notes, detail, search, tag filter, keyset pages, exact totals, soft delete", async () => {
        const made: string[] = [];
        for (let i = 0; i < 7; i++) {
          made.push((await newContact(i % 2 ? empCookie : ownerCookie, {
            firstName: `Pager${i}`, lastName: "Crm", email: `pager${i}-${run}@example.test`, tags: i < 3 ? ["vip"] : ["lead"],
          })).id);
        }
        const pages: string[][] = [];
        let cursor: string | null = null;
        let totals = new Set<number>();
        do {
          const r: R = await call(ownerCookie, "GET", `/api/contacts?q=pager&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          assert.equal(r.status, 200, r.text);
          pages.push(r.body.items.map((c: { id: string }) => c.id));
          totals.add(r.body.total);
          cursor = r.body.nextCursor;
        } while (cursor);
        assert.deepEqual(pages.map((p) => p.length), [3, 3, 1]);
        assert.deepEqual(pages.flat(), [...made].reverse(), "newest first, no overlap, nothing skipped");
        assert.deepEqual([...totals], [7]);
        const vip = await call(ownerCookie, "GET", "/api/contacts?tag=vip&limit=100");
        assert.deepEqual(vip.body.items.map((c: { id: string }) => c.id).sort(), made.slice(0, 3).sort());
        assert.equal(vip.body.total, 3);
        const one = await call(ownerCookie, "GET", "/api/contacts?q=pager4%20crm");
        assert.deepEqual(one.body.items.map((c: { id: string }) => c.id), [made[4]]);
        const injection = await call(ownerCookie, "GET", `/api/contacts?q=${encodeURIComponent("a,id.neq.0)or(x")}`);
        assert.equal(injection.status, 200, "filter syntax in a search is treated as text");

        const ada = await newContact(empCookie, { firstName: "Ada", lastName: "Crm", email: `ada-${run}@example.test`, phone: "781-964-0654",
          ownerUserId: emp.id, tags: ["vip"], workspaceId: wsA });
        assert.equal((await db.query("select workspace_id from public.contacts where id = $1", [ada.id])).rows[0].workspace_id, ws,
          "a body workspaceId is ignored");
        expect(await call(ownerCookie, "POST", "/api/contacts", { email: `ADA-${run}@example.test` }), 409, "duplicate_email", "duplicate email");
        for (const body of [{}, { email: "nope" }, { firstName: "X", tags: ["a,b"] }, { firstName: "X", extra: 1 }, { firstName: "X", ownerUserId: "me" }]) {
          expect(await call(ownerCookie, "POST", "/api/contacts", body), 422, "validation_failed", JSON.stringify(body));
        }
        for (const foreignOwner of [ownerA.id, outsider.id]) {
          expect(await call(ownerCookie, "POST", "/api/contacts", { firstName: "X", ownerUserId: foreignOwner }), 422, "validation_failed",
            `owner ${foreignOwner}`);
        }
        const edited = await call(empCookie, "PATCH", `/api/contacts/${ada.id}`, { lastName: "Lovelace", tags: ["vip", "engineer"], dnd: true });
        assert.equal(edited.status, 200, edited.text);
        assert.deepEqual([edited.body.contact.name, edited.body.contact.tags, edited.body.contact.dnd], ["Ada Lovelace", ["engineer", "vip"], true]);
        const note = await call(empCookie, "POST", `/api/contacts/${ada.id}/notes`, { body: "Prefers mornings" });
        assert.equal(note.status, 200, note.text);
        assert.deepEqual([note.body.note.authorUserId, note.body.note.authorName], [emp.id, "CRM Employee"], "the database stamps the author");
        const detail = await call(ownerCookie, "GET", `/api/contacts/${ada.id}`);
        assert.deepEqual([detail.body.contact.email, detail.body.notes.length, detail.body.notes[0].body], [`ada-${run}@example.test`, 1, "Prefers mornings"]);
        assert.deepEqual((await activity(ada.id)).map((a) => a.action), ["created", "updated", "note_added"]);
        const updated = (await activity(ada.id))[1];
        assert.deepEqual(updated.payload.fields.sort(), ["dnd", "last_name"], "activity records field names only");
        assert.equal(JSON.stringify(updated.payload).includes("Lovelace"), false);

        expect(await call(empCookie, "DELETE", `/api/contacts/${ada.id}`), 403, "forbidden", "employee deletes");
        const direct = await rpc(env, emp.token, "soft_delete_contact", { p_id: ada.id });
        assert.ok(direct.status >= 400 && /forbidden/.test(direct.text), `the database refuses the employee too: ${direct.text}`);
        const before = (await call(ownerCookie, "GET", "/api/contacts?limit=1")).body.total;
        assert.equal((await call(ownerCookie, "DELETE", `/api/contacts/${ada.id}`)).status, 200);
        assert.equal((await call(ownerCookie, "GET", "/api/contacts?limit=1")).body.total, before - 1, "the total drops by one");
        expect(await call(ownerCookie, "GET", `/api/contacts/${ada.id}`), 404, "not_found", "deleted detail");
        expect(await call(ownerCookie, "PATCH", `/api/contacts/${ada.id}`, { firstName: "Back" }), 404, "not_found", "editing a deleted contact");
        expect(await call(ownerCookie, "POST", `/api/contacts/${ada.id}/notes`, { body: "x" }), 404, "not_found", "noting a deleted contact");
        assert.equal((await db.query("select deleted_at is not null d from public.contacts where id = $1", [ada.id])).rows[0].d, true, "soft deleted, not removed");
        assert.ok((await db.query("select 1 from public.workspace_audit_log where workspace_id = $1 and action = 'contact.deleted' and actor_id = $2",
          [ws, owner.id])).rowCount, "the deletion is audited");

        for (const [method, path, json] of [["GET", `/api/contacts/${contactA}`], ["PATCH", `/api/contacts/${contactA}`, { firstName: "Hijack" }],
          ["POST", `/api/contacts/${contactA}/notes`, { body: "x" }], ["DELETE", `/api/contacts/${contactA}`]] as [string, string, unknown?][]) {
          expect(await call(ownerCookie, method, path, json), 404, "not_found", `${method} workspace A's contact`);
        }
        assert.equal((await db.query("select count(*)::int n from public.contact_notes where contact_id = $1", [contactA])).rows[0].n, 0);
      });

      test("CRUD-2 opportunities: stage ids decide columns and status; exact money; cross-workspace references refused", async () => {
        const contact = await newContact(ownerCookie, { firstName: "Deal", lastName: "Maker" });
        const create = (json: Record<string, unknown>, cookie = empCookie) => call(cookie, "POST", "/api/opportunities", json);
        const roof = await create({ contactId: contact.id, stageId: stages["New Lead"], title: "Roof", valueCents: 150050, assignedUserId: emp.id });
        assert.equal(roof.status, 200, roof.text);
        assert.deepEqual([roof.body.opportunity.status, roof.body.opportunity.valueCents, roof.body.opportunity.pipelineId, roof.body.opportunity.stageName],
          ["open", 150050, pipelineId, "New Lead"]);
        const gutter = await create({ contactId: contact.id, stageId: stages["New Lead"], title: "Gutter", valueCents: 1 });
        assert.equal(gutter.status, 200, gutter.text);

        const foreignStage = (await rest(env, ownerA.token, "GET", "pipeline_stages?select=id&limit=1")).body[0].id;
        for (const [json, label] of [
          [{ contactId: contactA, stageId: stages["New Lead"], title: "X" }, "workspace A's contact"],
          [{ contactId: contact.id, stageId: foreignStage, title: "X" }, "workspace A's stage"],
          [{ contactId: contact.id, stageId: stages["New Lead"], title: "X", assignedUserId: ownerA.id }, "workspace A's member"],
          [{ contactId: contact.id, stageId: stages["New Lead"], title: "X", valueCents: 1.5 }, "fractional cents"],
          [{ contactId: contact.id, stageId: stages["New Lead"], title: "X", valueCents: -100 }, "negative value"],
          [{ contactId: contact.id, stageId: "New Lead", title: "X" }, "stage by name"],
        ] as [Record<string, unknown>, string][]) {
          expect(await create(json), 422, "validation_failed", label);
        }
        const id = roof.body.opportunity.id;
        expect(await call(empCookie, "POST", `/api/opportunities/${id}/move`, { stageId: foreignStage }), 422, "validation_failed", "move to a foreign stage");
        const moved = await call(empCookie, "POST", `/api/opportunities/${id}/move`, { stageId: stages["Won"] });
        assert.equal(moved.status, 200, moved.text);
        assert.deepEqual([moved.body.opportunity.status, moved.body.opportunity.stageName, Boolean(moved.body.opportunity.closedAt)], ["won", "Won", true]);
        assert.deepEqual((await activity(id)).map((a) => a.action), ["created", "won"]);
        const back = await call(empCookie, "POST", `/api/opportunities/${id}/move`, { stageId: stages["Qualified"] });
        assert.deepEqual([back.body.opportunity.status, back.body.opportunity.closedAt], ["open", null], "reopening clears closed_at");
        const stageEvent = (await activity(id)).at(-1)!;
        assert.deepEqual([stageEvent.action, stageEvent.payload.from_stage_id, stageEvent.payload.to_stage_id], ["stage_changed", stages["Won"], stages["Qualified"]]);
        assert.equal((await call(empCookie, "POST", `/api/opportunities/${id}/move`, { stageId: stages["Won"] })).status, 200);

        const edited = await call(empCookie, "PATCH", `/api/opportunities/${id}`, { title: "Roof replacement", valueCents: 150049 });
        assert.deepEqual([edited.body.opportunity.title, edited.body.opportunity.valueCents], ["Roof replacement", 150049]);
        expect(await call(empCookie, "PATCH", `/api/opportunities/${id}`, { stageId: stages["Lost"] }), 422, "validation_failed", "stage via PATCH");

        const won = await call(ownerCookie, "GET", `/api/opportunities?stageId=${stages["Won"]}`);
        assert.deepEqual([won.body.total, won.body.items[0].id], [1, id]);
        const report = await call(ownerCookie, "GET", "/api/reports/summary");
        assert.equal(report.status, 200, report.text);
        assert.deepEqual([report.body.wonCount, report.body.wonValueCents], [1, 150049]);
        const newLead = report.body.leadsByStage.find((s: { stageId: string }) => s.stageId === stages["New Lead"]);
        assert.deepEqual([newLead.count, newLead.valueCents], [1, 1]);
        const page = await appFetch(app, "/pipeline", { cookie: ownerCookie });
        const text = page.text.replace(/<!-- -->/g, "");
        assert.ok(text.includes("$1,500.49<") && text.includes("$0.01<"), "board values are exact");
        assert.ok(text.includes("2 opportunities across 12 stage(s)"));
        assert.ok(text.includes("Add opportunity"), "owners can add from the board");
        assert.ok((await appFetch(app, "/pipeline", { cookie: empCookie })).text.includes("Add opportunity"), "employees hold opportunities.write");

        expect(await call(empCookie, "DELETE", `/api/opportunities/${id}`), 403, "forbidden", "employee deletes");
        expect(await call(empCookie, "PATCH", `/api/pipeline/stages/${stages["Qualified"]}`, { name: "Hot" }), 403, "forbidden", "employee renames a stage");
        const renamed = await call(ownerCookie, "PATCH", `/api/pipeline/stages/${stages["Qualified"]}`, { name: "Hot Leads" });
        assert.equal(renamed.body.stage.name, "Hot Leads");
        assert.equal((await call(ownerCookie, "DELETE", `/api/opportunities/${id}`)).status, 200);
        expect(await call(ownerCookie, "GET", `/api/opportunities/${id}`), 404, "not_found", "deleted opportunity");
        const after = await call(ownerCookie, "GET", "/api/reports/summary");
        assert.deepEqual([after.body.wonCount, after.body.wonValueCents], [0, 0], "deleted opportunities leave the totals");
        const foreignOpp = (await rest(env, ownerA.token, "GET", "opportunities?select=id&limit=1")).body[0]?.id;
        if (foreignOpp) {
          expect(await call(ownerCookie, "POST", `/api/opportunities/${foreignOpp}/move`, { stageId: stages["Won"] }), 404, "not_found", "foreign move");
          expect(await call(ownerCookie, "DELETE", `/api/opportunities/${foreignOpp}`), 404, "not_found", "foreign delete");
        }
      });

      test("CRUD-3 calendars and appointments: members, availability, timestamps, and overlap under concurrency", async () => {
        const create = (json: Record<string, unknown>, cookie = ownerCookie) => call(cookie, "POST", "/api/calendars", json);
        expect(await create({ name: "X", slug: `x-${run}`, timezone: "UTC", durationMinutes: 30 }, empCookie), 403, "forbidden", "employee creates");
        const cal = await create({ name: "Consults", slug: `consults-${run}`, timezone: "America/New_York", durationMinutes: 30, memberUserIds: [emp.id, owner.id] });
        assert.equal(cal.status, 200, cal.text);
        const calId = cal.body.calendar.id;
        assert.deepEqual(cal.body.calendar.members.map((m: { userId: string }) => m.userId).sort(), [emp.id, owner.id].sort());
        expect(await create({ name: "Dup", slug: `consults-${run}`, timezone: "UTC", durationMinutes: 30 }), 409, "duplicate_slug", "duplicate slug");
        for (const member of [outsider.id, ownerA.id]) {
          expect(await create({ name: "M", slug: `m-${member.slice(0, 8)}-${run}`, timezone: "UTC", durationMinutes: 30, memberUserIds: [member] }),
            422, "validation_failed", `member ${member}`);
        }
        const avail = await call(ownerCookie, "PUT", `/api/calendars/${calId}/availability`,
          { rules: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "13:00", end: "17:00" }, { weekday: 3, start: "10:00", end: "14:00" }] });
        assert.equal(avail.status, 200, avail.text);
        assert.equal(avail.body.rules.length, 3);
        expect(await call(ownerCookie, "PUT", `/api/calendars/${calId}/availability`, { rules: [{ weekday: 1, start: "09:00", end: "12:00" },
          { weekday: 1, start: "11:00", end: "13:00" }] }), 422, "validation_failed", "overlapping windows");
        assert.equal((await call(ownerCookie, "GET", "/api/calendars")).body.items.find((c: { id: string }) => c.id === calId).rules.length, 3,
          "a refused replacement changes nothing");
        expect(await call(empCookie, "PUT", `/api/calendars/${calId}/availability`, { rules: [] }), 403, "forbidden", "employee edits hours");
        const patched = await call(ownerCookie, "PATCH", `/api/calendars/${calId}`, { memberUserIds: [owner.id], durationMinutes: 45 });
        assert.deepEqual([patched.body.calendar.members.length, patched.body.calendar.durationMinutes], [1, 45]);

        const contact = await newContact(empCookie, { firstName: "Booked", lastName: "Client" });
        const book = (json: Record<string, unknown>) => call(empCookie, "POST", "/api/appointments", { calendarId: calId, contactId: contact.id, ...json });
        const first = await book({ startsAt: "2031-06-02T09:00:00-04:00", endsAt: "2031-06-02T09:45:00-04:00", assignedUserId: emp.id });
        assert.equal(first.status, 200, first.text);
        assert.equal(Date.parse(first.body.appointment.startsAt), Date.parse("2031-06-02T13:00:00Z"), "offsets are honoured");
        const racers = await Promise.all([
          book({ startsAt: "2031-06-03T14:00:00Z", endsAt: "2031-06-03T14:45:00Z" }),
          book({ startsAt: "2031-06-03T14:30:00Z", endsAt: "2031-06-03T15:15:00Z" }),
        ]);
        assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409], racers.map((r) => r.text).join(" | "));
        assert.equal(racers.find((r) => r.status === 409)!.body.code, "overlap");
        const loser = racers.find((r) => r.status === 200)!.body.appointment;
        expect(await book({ startsAt: "2031-06-02T13:30:00Z", endsAt: "2031-06-02T14:00:00Z" }), 409, "overlap", "overlapping booking");
        expect(await call(empCookie, "PATCH", `/api/appointments/${loser.id}`, { startsAt: "2031-06-02T13:15:00Z", endsAt: "2031-06-02T13:50:00Z" }),
          409, "overlap", "rescheduling onto a booking");
        const cancelled = await call(empCookie, "PATCH", `/api/appointments/${first.body.appointment.id}`, { status: "cancelled" });
        assert.equal(cancelled.body.appointment.status, "cancelled");
        assert.equal((await book({ startsAt: "2031-06-02T13:30:00Z", endsAt: "2031-06-02T14:00:00Z" })).status, 200, "a cancelled slot is free again");
        const moved = await call(empCookie, "PATCH", `/api/appointments/${loser.id}`, { startsAt: "2031-06-04T14:00:00Z", endsAt: "2031-06-04T14:45:00Z" });
        assert.equal(moved.status, 200, moved.text);
        assert.deepEqual((await activity(loser.id)).map((a) => a.action), ["created", "rescheduled"]);
        for (const [json, label] of [
          [{ startsAt: "2031-06-05T14:00:00Z", endsAt: "2031-06-05T13:00:00Z" }, "end before start"],
          [{ startsAt: "2031-06-05T14:00:00Z", endsAt: "2031-06-06T15:00:00Z" }, "longer than a day"],
          [{ startsAt: "2031-06-05 14:00", endsAt: "2031-06-05 15:00" }, "no offset"],
          [{ startsAt: "2031-06-05T14:00:00Z", endsAt: "2031-06-05T15:00:00Z", contactId: contactA }, "workspace A's contact"],
          [{ startsAt: "2031-06-05T14:00:00Z", endsAt: "2031-06-05T15:00:00Z", assignedUserId: employeeA.id }, "workspace A's member"],
        ] as [Record<string, unknown>, string][]) {
          expect(await book(json), 422, "validation_failed", label);
        }
        const range = await call(ownerCookie, "GET", `/api/appointments?calendarId=${calId}&from=2031-06-02T00:00:00Z&to=2031-06-04T00:00:00Z`);
        assert.equal(range.status, 200, range.text);
        assert.deepEqual(range.body.items.map((a: { status: string }) => a.status), ["cancelled", "booked"], "soonest first, range applied");
        expect(await call(ownerCookie, "GET", "/api/appointments?from=2031-01-01T00:00:00Z&to=2032-06-01T00:00:00Z"), 422, "validation_failed", "range too long");

        assert.equal((await call(ownerCookie, "PATCH", `/api/calendars/${calId}`, { active: false })).status, 200);
        expect(await book({ startsAt: "2031-06-07T14:00:00Z", endsAt: "2031-06-07T14:30:00Z" }), 422, "validation_failed", "inactive calendar");
        const calendarPage = await appFetch(app, "/calendar", { cookie: ownerCookie });
        assert.ok(calendarPage.text.includes("Not accepting bookings."), "inactive calendars stay listed for editing");
        assert.equal((await call(ownerCookie, "PATCH", `/api/calendars/${calId}`, { active: true })).status, 200);
        const shown = (await appFetch(app, "/calendar", { cookie: ownerCookie })).text.replace(/<!-- -->/g, "");
        assert.ok(shown.includes("booked · 2031-06-02 13:30") && shown.includes("Book appointment"), "bookings render with UTC times");
        expect(await call(ownerCookie, "PATCH", `/api/calendars/${calId}`, { slug: "Bad Slug" }), 422, "validation_failed", "bad slug");
      });

      test("CRUD-4 tasks: assignment, status changes, removed and foreign assignees refused, read-only overrides enforced twice", async () => {
        const create = (json: Record<string, unknown>, cookie = ownerCookie) => call(cookie, "POST", "/api/tasks", json);
        const t = await create({ title: "Call back", assignedUserId: emp.id, dueAt: "2031-06-01T15:00:00-04:00" });
        assert.equal(t.status, 200, t.text);
        assert.deepEqual([t.body.task.assignedName, t.body.task.status, Date.parse(t.body.task.dueAt)], ["CRM Employee", "open", Date.parse("2031-06-01T19:00:00Z")]);
        const done = await call(empCookie, "PATCH", `/api/tasks/${t.body.task.id}`, { status: "done" });
        assert.equal(done.body.task.status, "done");
        assert.deepEqual((await activity(t.body.task.id)).map((a) => a.action), ["created", "completed"]);

        const leaverTask = await create({ title: "Leaver work", assignedUserId: leaver.id });
        assert.equal(leaverTask.status, 200, leaverTask.text);
        assert.equal((await call(ownerCookie, "DELETE", `/api/team/${leaver.id}`)).status, 200);
        expect(await create({ title: "After removal", assignedUserId: leaver.id }), 422, "validation_failed", "removed assignee");
        expect(await call(ownerCookie, "PATCH", `/api/tasks/${leaverTask.body.task.id}`, { assignedUserId: leaver.id }), 422, "validation_failed",
          "reassigning to a removed member");
        expect(await call(ownerCookie, "POST", "/api/contacts", { firstName: "X", ownerUserId: leaver.id }), 422, "validation_failed", "removed contact owner");
        for (const foreign of [employeeA.id, outsider.id]) {
          expect(await create({ title: "Foreign", assignedUserId: foreign }), 422, "validation_failed", `assignee ${foreign}`);
        }
        expect(await create({ title: "Linked", contactId: contactA }), 422, "validation_failed", "workspace A's contact");
        for (const body of [{ title: "" }, { title: "x", status: "late" }, { title: "x", dueAt: "soon" }]) {
          expect(await create(body), 422, "validation_failed", JSON.stringify(body));
        }

        for (let i = 0; i < 4; i++) assert.equal((await create({ title: `Batch ${i}` })).status, 200);
        const open = await call(ownerCookie, "GET", "/api/tasks?status=open&limit=2");
        const openCount = (await db.query<{ n: number }>("select count(*)::int n from public.tasks where workspace_id = $1 and status = 'open' and deleted_at is null", [ws])).rows[0].n;
        assert.equal(open.body.total, openCount);
        const second = await call(ownerCookie, "GET", `/api/tasks?status=open&limit=2&cursor=${encodeURIComponent(open.body.nextCursor)}`);
        assert.equal(second.body.items.some((x: { id: string }) => open.body.items.some((y: { id: string }) => y.id === x.id)), false, "pages do not overlap");
        const tasksPage = (await appFetch(app, "/tasks", { cookie: ownerCookie })).text.replace(/<!-- -->/g, "");
        assert.ok(tasksPage.includes(`${openCount} open · 1 completed`), "the page shows exact counts");

        const ov = await call(ownerCookie, "PATCH", `/api/team/${emp.id}`, { overrides: { "tasks.write": false, "conversations.write": false, "contacts.write": false } });
        assert.equal(ov.status, 200, ov.text);
        try {
          expect(await create({ title: "Denied" }, empCookie), 403, "forbidden", "read-only tasks");
          expect(await call(empCookie, "PATCH", `/api/tasks/${t.body.task.id}`, { status: "open" }), 403, "forbidden", "read-only status change");
          expect(await call(empCookie, "POST", "/api/contacts", { firstName: "Denied" }), 403, "forbidden", "read-only contacts");
          const directTask = await rest(env, emp.token, "POST", "tasks", { workspace_id: ws, title: "Direct" });
          assert.ok(directTask.status >= 400, `the database refuses a read-only grant too: ${directTask.status}`);
          const directContact = await rest(env, emp.token, "POST", "contacts", { workspace_id: ws, first_name: "Direct" });
          assert.ok(directContact.status >= 400, `contacts: ${directContact.status}`);
          assert.equal((await call(empCookie, "GET", "/api/tasks?limit=1")).status, 200, "reading still works");
          assert.equal((await appFetch(app, "/tasks", { cookie: empCookie })).text.includes("Add task"), false, "the page hides the control");
        } finally {
          const cleared = await call(ownerCookie, "PATCH", `/api/team/${emp.id}`, { overrides: { "tasks.write": null, "conversations.write": null, "contacts.write": null } });
          assert.equal(cleared.status, 200, cleared.text);
        }
        assert.equal((await create({ title: "Allowed again" }, empCookie)).status, 200);
      });

      test("CRUD-5 inbox: conversations and messages read with pagination; internal notes only; nothing can be sent", async () => {
        const contact = await newContact(ownerCookie, { firstName: "Inbox", lastName: "Contact" });
        const convo = (await db.query<{ id: string }>(
          "insert into public.conversations (workspace_id, contact_id, channel, status) values ($1, $2, 'sms', 'open') returning id",
          [ws, contact.id])).rows[0].id;
        for (let i = 0; i < 3; i++) {
          await db.query(`insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status, created_at)
            values ($1, $2, 'inbound', $3, 'delivered', now() - make_interval(mins => $4))`, [ws, convo, `Inbound ${i}`, 10 - i]);
        }
        const list = await call(empCookie, "GET", "/api/conversations?status=open");
        assert.equal(list.status, 200, list.text);
        assert.ok(list.body.items.some((c: { id: string; contactName: string }) => c.id === convo && c.contactName === "Inbox Contact"));
        const m1 = await call(empCookie, "GET", `/api/conversations/${convo}/messages?limit=2`);
        assert.deepEqual(m1.body.items.map((m: { body: string }) => m.body), ["Inbound 2", "Inbound 1"]);
        const m2 = await call(empCookie, "GET", `/api/conversations/${convo}/messages?limit=2&cursor=${encodeURIComponent(m1.body.nextCursor)}`);
        assert.deepEqual([m2.body.items.map((m: { body: string }) => m.body), m2.body.nextCursor], [["Inbound 0"], null]);

        const note = await call(empCookie, "POST", `/api/conversations/${convo}/notes`, { body: "Customer prefers texts after 5pm" });
        assert.equal(note.status, 200, note.text);
        assert.deepEqual([note.body.message.direction, note.body.message.deliveryStatus, note.body.message.authorUserId], ["internal", "not_sent", emp.id]);
        const stored = await db.query("select direction, delivery_status, author_user_id from public.messages where id = $1", [note.body.message.id]);
        assert.deepEqual(stored.rows[0], { direction: "internal", delivery_status: "not_sent", author_user_id: emp.id });
        expect(await call(empCookie, "POST", `/api/conversations/${convo}/notes`, { body: "x", direction: "outbound" }), 422, "validation_failed", "outbound via API");
        const outbound = await rest(env, owner.token, "POST", "messages", { workspace_id: ws, conversation_id: convo, direction: "outbound", body: "Hi" });
        assert.ok(outbound.status >= 400, `clients cannot insert outbound messages: ${outbound.status} ${outbound.text}`);
        const queued = await rest(env, owner.token, "POST", "messages", { workspace_id: ws, conversation_id: convo, direction: "internal", body: "x", delivery_status: "queued" });
        assert.ok(queued.status >= 400, `clients cannot set delivery status: ${queued.status}`);
        assert.equal((await db.query("select count(*)::int n from public.messages where conversation_id = $1 and direction <> 'inbound'", [convo])).rows[0].n, 1);
        const foreignConvo = await db.query<{ id: string }>("select id from public.conversations where workspace_id = $1 limit 1", [wsA]);
        if (foreignConvo.rowCount) {
          expect(await call(ownerCookie, "GET", `/api/conversations/${foreignConvo.rows[0].id}/messages`), 404, "not_found", "foreign thread");
          expect(await call(ownerCookie, "POST", `/api/conversations/${foreignConvo.rows[0].id}/notes`, { body: "x" }), 404, "not_found", "foreign note");
        }
        const inbox = await appFetch(app, "/inbox", { cookie: ownerCookie });
        assert.ok(inbox.text.includes("Inbox Contact") && inbox.text.includes("Conversation Threads"));
        assert.equal(app.outbound().length, 0, "no outbound connection attempted");
      });

      test("workspace switching: records follow the active workspace; ids of the other workspace answer 404", async () => {
        const mine = await newContact(ownerCookie, { firstName: "Switch", lastName: "Home" });
        assert.equal((await db.query("select workspace_id from public.contacts where id = $1", [mine.id])).rows[0].workspace_id, ws);
        const inv = await rpc(env, ownerB.token, "create_invitation", { p_email: owner.email, p_role: "employee", p_ttl_hours: 24 });
        assert.equal(inv.status, 200, inv.text);
        assert.equal((await rpc(env, owner.token, "accept_invitation", { p_token: inv.body.token })).status, 200);
        assert.equal((await call(ownerCookie, "GET", "/api/auth/me")).body.workspace.id, wsB, "accepting an invitation activates its workspace");
        const back = await call(ownerCookie, "POST", "/api/workspaces/active", { workspaceId: ws });
        assert.equal(back.status, 200, back.text);
        assert.equal((await call(ownerCookie, "GET", `/api/contacts/${mine.id}`)).status, 200, "home contact visible at home");
        const toB = await call(ownerCookie, "POST", "/api/workspaces/active", { workspaceId: wsB });
        assert.equal(toB.status, 200, toB.text);
        try {
          const listB = await call(ownerCookie, "GET", "/api/contacts?limit=100");
          const countB = (await db.query<{ n: number }>("select count(*)::int n from public.contacts where workspace_id = $1 and deleted_at is null", [wsB])).rows[0].n;
          assert.equal(listB.body.total, countB);
          const items = listB.body.items as { id: string; name: string }[];
          const owners = await db.query<{ id: string; workspace_id: string }>("select id, workspace_id from public.contacts where id = any($1::uuid[])",
            [items.map((c) => c.id)]);
          const foreign = owners.rows.filter((r) => r.workspace_id !== wsB);
          assert.deepEqual(foreign, [], `every listed contact belongs to workspace B: ${JSON.stringify(items.map((c) => c.name))}`);
          assert.equal(items.some((c) => c.id === mine.id), false, "the home contact is not listed");
          expect(await call(ownerCookie, "GET", `/api/contacts/${mine.id}`), 404, "not_found", "home contact from B");
          expect(await call(ownerCookie, "PATCH", `/api/contacts/${mine.id}`, { firstName: "X" }), 404, "not_found", "home contact edit from B");
          expect(await call(ownerCookie, "DELETE", `/api/contacts/${contactB}`), 403, "forbidden", "employee in B cannot delete");
          const inB = await newContact(ownerCookie, { firstName: "Made", lastName: "InB" });
          assert.equal((await db.query("select workspace_id from public.contacts where id = $1", [inB.id])).rows[0].workspace_id, wsB);
          assert.equal((await appFetch(app, "/contacts", { cookie: ownerCookie })).text.includes("Switch Home"), false);
        } finally {
          const home = await call(ownerCookie, "POST", "/api/workspaces/active", { workspaceId: ws });
          assert.equal(home.status, 200, home.text);
        }
        assert.equal((await call(ownerCookie, "GET", `/api/contacts/${mine.id}`)).status, 200);
      });

      test("browser: contacts, opportunities, calendars, tasks, and inbox notes work in the existing pages", async () => {
        const shots = mkdtempSync(join(tmpdir(), "fna-p5-browser-"));
        const base = app.url.replace("//127.0.0.1:", "//localhost:");
        const bOwner = await signUp(env, email("crm-browser"), "CRM Browser Owner");
        const prov = await rpc(env, platformAal2, "platform_provision_workspace", {
          p_provisioning_key: `synthetic-crm-browser-${run}`, p_name: "CRM Browser (synthetic)", p_slug: `crm-browser-${run}`, p_owner_email: bOwner.email,
        });
        assert.equal(prov.status, 200, prov.text);
        const bws = prov.body.workspace_id;
        assert.equal((await rpc(env, bOwner.token, "accept_invitation", { p_token: prov.body.invite_token })).status, 200);
        const browser = await launchBrowser();
        try {
          const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: "America/New_York" });
          ctx.setDefaultTimeout(20_000);
          await ctx.addInitScript("window.__name = (f) => f");
          const page = await ctx.newPage();
          const go = async (path: string) => {
            await page.goto(`${base}${path}`);
            await page.waitForLoadState("networkidle");
          };
          await page.goto(`${base}/login`);
          await page.fill("#email", bOwner.email);
          await page.fill("#password", bOwner.password);
          await page.click("button[type=submit]");
          await page.waitForURL(/\/dashboard$/);

          await go("/contacts");
          await page.getByRole("button", { name: "Add a contact" }).click();
          const dialog = page.getByRole("dialog");
          await dialog.locator("#c-first").fill("Browser");
          await dialog.locator("#c-last").fill("Contact");
          await dialog.locator("#c-email").fill(`browser-${run}@example.test`);
          await dialog.locator("#c-phone").fill("call me");
          await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
          await page.getByRole("alert").getByText("Enter a valid phone number").waitFor();
          await dialog.locator("#c-phone").fill("781-964-0654");
          await dialog.locator("#c-tags").fill("vip, browser");
          await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
          await page.getByText("Browser Contact was added.").waitFor();
          await page.fill("#contact-search", "browser");
          await page.getByRole("button", { name: "Open Browser Contact" }).click();
          await page.locator("#c-note").fill("Met at the browser test");
          await page.getByRole("button", { name: "Save note" }).click();
          await page.getByText("Met at the browser test").waitFor();
          await page.screenshot({ path: join(shots, "contacts.png"), fullPage: true });
          await page.getByRole("button", { name: "Close dialog" }).click();

          await go("/pipeline");
          await page.getByRole("button", { name: "Add opportunity" }).click();
          await page.locator("#opp-contact option", { hasText: "Browser Contact" }).waitFor({ state: "attached" });
          await page.selectOption("#opp-contact", { label: "Browser Contact" });
          await page.fill("#opp-title", "Browser deal");
          await page.selectOption("#opp-stage", { label: "New Lead" });
          await page.fill("#opp-value", "1234.56");
          await page.getByRole("dialog").getByRole("button", { name: "Add opportunity" }).click();
          await page.getByText("$1,234.56 combined").waitFor();
          await page.getByRole("button", { name: "Edit opportunity" }).click();
          await page.getByRole("dialog").getByText("Browser Contact · $1,234.56 · open").waitFor();
          await page.getByRole("dialog").getByLabel("Stage").selectOption({ label: "Won" });
          await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
          await page.getByRole("dialog").waitFor({ state: "detached" });
          const opp = await db.query<{ status: string; value_cents: string; closed: boolean }>(
            "select status, value_cents::text, closed_at is not null closed from public.opportunities where workspace_id = $1", [bws]);
          assert.deepEqual(opp.rows, [{ status: "won", value_cents: "123456", closed: true }]);
          await page.screenshot({ path: join(shots, "pipeline.png"), fullPage: true });

          await go("/calendar");
          await page.getByRole("button", { name: "Create calendar" }).click();
          await page.fill("#cal-name", "Browser Calls");
          assert.equal(await page.locator("#cal-slug").inputValue(), "browser-calls");
          await page.getByLabel("CRM Browser Owner").check();
          await page.getByRole("dialog").getByRole("button", { name: "Create calendar" }).click();
          await page.getByRole("heading", { name: "Browser Calls" }).waitFor();
          await page.getByRole("button", { name: "Book appointment" }).click();
          await page.locator("#appt-contact option", { hasText: "Browser Contact" }).waitFor({ state: "attached" });
          await page.selectOption("#appt-contact", { label: "Browser Contact" });
          await page.fill("#appt-start", "2031-07-01T10:00");
          assert.equal(await page.locator("#appt-end").inputValue(), "2031-07-01T10:30", "the end follows the calendar duration");
          await page.getByRole("dialog").getByRole("button", { name: "Book appointment" }).click();
          await page.getByText("booked · 2031-07-01 14:00").waitFor();
          await page.getByRole("button", { name: "Book appointment" }).click();
          await page.locator("#appt-contact option", { hasText: "Browser Contact" }).waitFor({ state: "attached" });
          await page.selectOption("#appt-contact", { label: "Browser Contact" });
          await page.fill("#appt-start", "2031-07-01T10:15");
          await page.getByRole("dialog").getByRole("button", { name: "Book appointment" }).click();
          await page.getByText("That time overlaps another booking on this calendar.").waitFor();
          await page.screenshot({ path: join(shots, "calendar-overlap.png"), fullPage: true });
          await page.getByRole("button", { name: "Close dialog" }).click();
          const appts = await db.query<{ starts_at: Date }>("select starts_at from public.appointments where workspace_id = $1", [bws]);
          assert.deepEqual(appts.rows.map((r) => r.starts_at.toISOString()), ["2031-07-01T14:00:00.000Z"], "10:00 New York is 14:00 UTC");

          await go("/tasks");
          await page.getByRole("button", { name: "Add task" }).click();
          await page.fill("#task-title", "Browser follow-up");
          await page.locator("#task-assignee option", { hasText: "CRM Browser Owner" }).waitFor({ state: "attached" });
          await page.selectOption("#task-assignee", { label: "CRM Browser Owner" });
          await page.getByRole("dialog").getByRole("button", { name: "Add task" }).click();
          await page.getByText(/Browser follow-up · open/).waitFor();
          await page.getByRole("button", { name: "Mark Browser follow-up done" }).click();
          await page.getByText(/Browser follow-up · done/).waitFor();
          await page.getByText("1 task(s) · 0 open · 1 completed.").waitFor();
          await page.screenshot({ path: join(shots, "tasks.png"), fullPage: true });

          const contactId = (await db.query<{ id: string }>("select id from public.contacts where workspace_id = $1", [bws])).rows[0].id;
          const convo = (await db.query<{ id: string }>(
            "insert into public.conversations (workspace_id, contact_id, channel, status) values ($1, $2, 'email', 'open') returning id", [bws, contactId])).rows[0].id;
          await db.query("insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status) values ($1, $2, 'inbound', 'Is Tuesday free?', 'delivered')",
            [bws, convo]);
          await go("/inbox");
          await page.getByRole("button", { name: "Open conversation with Browser Contact" }).click();
          await page.getByText("Is Tuesday free?").waitFor();
          await page.fill("#convo-note", "Offered Tuesday 10am by phone");
          await page.getByRole("button", { name: "Save internal note" }).click();
          await page.getByRole("dialog").getByText("Offered Tuesday 10am by phone").waitFor();
          await page.getByRole("dialog").getByText("Internal note", { exact: true }).waitFor();
          await page.screenshot({ path: join(shots, "inbox.png"), fullPage: true });
          const msgs = await db.query("select direction, delivery_status from public.messages where conversation_id = $1 order by created_at", [convo]);
          assert.deepEqual(msgs.rows, [{ direction: "inbound", delivery_status: "delivered" }, { direction: "internal", delivery_status: "not_sent" }]);
          console.log(`P5 browser screenshots: ${shots}`);
        } catch (err) {
          let n = 0;
          for (const c of browser.contexts()) {
            for (const p of c.pages()) {
              console.error(`P5 browser page ${n}: ${p.url()}`);
              await p.screenshot({ path: join(shots, `failure-${n++}.png`), fullPage: true }).catch(() => undefined);
            }
          }
          console.error(`P5 browser flow failed (screenshots so far: ${shots}):`, err);
          throw err;
        } finally {
          await browser.close().catch(() => undefined);
        }
      });
    });

    // P6: the platform console, through the app only. The admin reaches AAL2 with the app's own MFA
    // endpoints (real GoTrue TOTP); every check uses that admin's cookies. The superuser connection
    // only registers the platform admin (stands in for the bootstrap script) and verifies outcomes.
    describe("platform console through the app (P6)", () => {
      let admin: Identity;
      let adminCookie = "";
      let factorId = "";
      let secret = "";
      let lastCode = "";
      let wsP = "";
      let firstToken = "";
      let pOwnerCookie = "";
      let pContact = "";
      const REASON = "Synthetic support check for P6";
      const BUSINESS = "P6 Alpha (synthetic)";
      const TOKEN_LIKE = /[0-9a-f]{64}|invite_token|token_hash/;

      type R = Awaited<ReturnType<typeof appFetch>>;
      const expect = (r: R, status: number, code: string | null, label: string) =>
        assert.deepEqual([r.status, code === null ? null : r.body?.code], [status, code], `${label}: ${r.text.slice(0, 240)}`);
      const call = (cookie: string, method: string, path: string, json?: unknown) => appFetch(app, path, { method, cookie, json });
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
      // GoTrue may refuse a code it has already accepted, so each verification waits for a new one.
      const freshCode = async () => {
        let c = totp(secret);
        while (c === lastCode) {
          await new Promise((r) => setTimeout(r, 1000));
          c = totp(secret);
        }
        lastCode = c;
        return c;
      };
      const verifyWithApp = async (cookie: string) => {
        const r = await call(cookie, "POST", "/api/auth/mfa/verify", { factorId, code: await freshCode() });
        assert.equal(r.status, 200, r.text);
        assert.deepEqual([r.body.aal, r.body.platformActive], ["aal2", true]);
        const next = mergeCookies(cookie, r.setCookies);
        assert.equal(jwtPayload(readSessionCookie(next).session.access_token).aal, "aal2", "the app's cookies now carry an AAL2 session");
        return next;
      };
      const tokenOf = (url: unknown) => {
        const m = /^http:\/\/127\.0\.0\.1:\d+\/invite\/([0-9a-f]{64})$/.exec(String(url));
        assert.ok(m, `invite link: ${String(url)}`);
        return m![1];
      };
      const platformAudit = async (ws: string) =>
        (await db.query<{ action: string; actor_id: string; reason: string | null; metadata: any }>(
          "select action, actor_id, reason, metadata from public.platform_audit_log where workspace_id = $1 order by id", [ws])).rows;
      const grantTo = async (ws: string, mode: "read" | "write", minutes = 30) => {
        const r = await call(adminCookie, "POST", `/api/platform/workspaces/${ws}/access`, { mode, reason: REASON, durationMinutes: minutes });
        assert.equal(r.status, 200, r.text);
        assert.deepEqual([r.body.grant.workspaceId, r.body.grant.mode], [ws, mode]);
        return r.body.grant as { id: string; expiresAt: string };
      };
      const endGrant = async (id: string) => {
        const r = await call(adminCookie, "DELETE", `/api/platform/access/${id}`, { reason: "Support session finished" });
        assert.ok(r.status === 200 || r.body?.code === "not_found", r.text);
      };

      before(async () => {
        admin = await signUp(env, email("p6-admin"), "P6 Platform Admin");
        await db.query("insert into public.platform_admins (user_id) values ($1)", [admin.id]);
      });

      test("P6 denial: non-admins get 403/404; a listed admin with a password session must verify an authenticator first", async () => {
        const surface: [string, string, unknown?][] = [
          ["GET", "/api/platform/workspaces"],
          ["POST", "/api/platform/workspaces", { provisioningKey: `p6-denied-${run}`, name: "Denied", slug: `p6-denied-${run}`, ownerEmail: email("p6-denied") }],
          ["GET", `/api/platform/workspaces/${wsA}`],
          ["POST", `/api/platform/workspaces/${wsA}/suspend`, { reason: REASON }],
          ["POST", `/api/platform/workspaces/${wsA}/access`, { mode: "write", reason: REASON, durationMinutes: 5 }],
          ["POST", `/api/platform/workspaces/${wsA}/bootstrap-invitation`, { reason: REASON }],
          ["GET", `/api/platform/workspaces/${wsA}/audit`],
          ["GET", "/api/platform/audit"],
          ["GET", "/api/platform/access"],
        ];
        for (const [m, p, j] of surface) expect(await appFetch(app, p, { method: m, json: j }), 401, "unauthenticated", `signed out ${m} ${p}`);
        for (const [m, p, j] of surface) expect(await call(ownerCookie, m, p, j), 403, "forbidden", `member ${m} ${p}`);
        expect(await call(ownerCookie, "GET", "/api/auth/mfa"), 403, "forbidden", "member MFA status");
        expect(await call(ownerCookie, "POST", "/api/auth/mfa/enroll", {}), 403, "forbidden", "member MFA enrolment");
        for (const path of ["/platform", "/platform/audit", `/platform/workspaces/${wsA}`, "/platform/mfa"]) {
          const page = await appFetch(app, path, { cookie: ownerCookie });
          assert.equal(page.status, 404, `member page ${path}`);
          assert.equal(page.text.includes("Platform administration"), false, `${path}: console not rendered`);
        }

        adminCookie = await appLogin(app, admin);
        for (const [m, p, j] of surface) expect(await call(adminCookie, m, p, j), 403, "mfa_required", `AAL1 admin ${m} ${p}`);
        const toMfa = await appFetch(app, "/platform", { cookie: adminCookie });
        assert.equal(toMfa.status, 307);
        assert.equal(new URL(toMfa.location!, app.url).pathname, "/platform/mfa");
        assert.equal(toMfa.text.includes("All workspaces"), false);
        const mfaPage = await appFetch(app, "/platform/mfa", { cookie: adminCookie });
        assert.equal(mfaPage.status, 200);
        assert.ok(mfaPage.text.includes("Platform administration requires your authenticator app."));
        const noAccess = await appFetch(app, "/no-access", { cookie: adminCookie });
        assert.ok(noAccess.text.includes("Verify authenticator for platform administration"), "the no-access page points a listed admin to MFA");

        assert.equal((await db.query("select status from public.workspaces where id = $1", [wsA])).rows[0].status, "active");
        assert.equal((await db.query("select count(*)::int n from public.platform_audit_log where actor_id = $1", [admin.id])).rows[0].n, 0);
        assert.equal((await db.query("select count(*)::int n from public.platform_access_grants where admin_user_id = $1", [admin.id])).rows[0].n, 0);
      });

      test("MFA through the app: enrol (abandoned enrolments replaced), wrong codes refused, AAL2 cookies issued, re-login needs a code again", async () => {
        const st = await call(adminCookie, "GET", "/api/auth/mfa");
        assert.equal(st.status, 200, st.text);
        assert.deepEqual([st.body.aal, st.body.platformActive, st.body.factors], ["aal1", false, []]);
        const abandoned = await call(adminCookie, "POST", "/api/auth/mfa/enroll", {});
        assert.equal(abandoned.status, 200, abandoned.text);
        const en = await call(adminCookie, "POST", "/api/auth/mfa/enroll", {});
        assert.equal(en.status, 200, en.text);
        assert.notEqual(en.body.factorId, abandoned.body.factorId);
        ({ factorId, secret } = en.body);
        assert.match(String(en.body.qrCode), /^data:image\/svg/);
        assert.equal(en.headers.get("cache-control"), "private, no-store");
        const factors = await db.query<{ id: string; status: string }>("select id, status::text from auth.mfa_factors where user_id = $1", [admin.id]);
        assert.deepEqual(factors.rows, [{ id: factorId, status: "unverified" }], "the abandoned enrolment was removed");

        const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, "0");
        expect(await call(adminCookie, "POST", "/api/auth/mfa/verify", { factorId, code: wrong }), 422, "validation_failed", "wrong code");
        expect(await call(adminCookie, "POST", "/api/auth/mfa/verify", { factorId, code: "12" }), 422, "validation_failed", "short code");
        expect(await call(adminCookie, "POST", "/api/auth/mfa/verify", { factorId: "nope", code: "123456" }), 422, "validation_failed", "bad factor id");
        expect(await call(adminCookie, "GET", "/api/platform/workspaces"), 403, "mfa_required", "still AAL1 after wrong codes");

        adminCookie = await verifyWithApp(adminCookie);
        expect(await call(adminCookie, "POST", "/api/auth/mfa/enroll", {}), 409, "factor_exists", "second authenticator");
        assert.equal((await call(adminCookie, "GET", "/api/platform/workspaces")).status, 200);
        const consolePage = await appFetch(app, "/platform", { cookie: adminCookie });
        assert.equal(consolePage.status, 200);
        for (const marker of ["Platform administration", "All workspaces", "Active support access"]) assert.ok(consolePage.text.includes(marker), marker);
        assert.equal(/class="sidebar/.test(consolePage.text), false, "the console has no client sidebar");
        const back = await appFetch(app, "/platform/mfa", { cookie: adminCookie });
        assert.deepEqual([back.status, new URL(back.location!, app.url).pathname], [307, "/platform"]);

        const relogin = await appLogin(app, admin);
        expect(await call(relogin, "GET", "/api/platform/workspaces"), 403, "mfa_required", "a new password session is AAL1 again");
        const again = await call(relogin, "GET", "/api/auth/mfa");
        assert.deepEqual(again.body.factors.map((f: { id: string }) => f.id), [factorId]);
        assert.equal(JSON.stringify(again.body).includes(secret), false, "the setup key is never shown again");
        const upgraded = await verifyWithApp(relogin);
        assert.equal((await call(upgraded, "GET", "/api/platform/audit")).status, 200);
      });

      test("provisioning through the app: validated, idempotent, one winner under concurrency, owner link shown once", async () => {
        const body = { provisioningKey: `p6-alpha-${run}`, name: BUSINESS, slug: `p6-alpha-${run}`, ownerEmail: email("p6-alpha-owner") };
        for (const [bad, field] of [[{ ...body, slug: "Bad Slug" }, "slug"], [{ ...body, ownerEmail: "nope" }, "ownerEmail"],
          [{ ...body, status: "active" }, "body"], [{ ...body, workspaceId: wsA, provisioningKey: "x" }, "provisioningKey"]] as const) {
          const r = await call(adminCookie, "POST", "/api/platform/workspaces", bad);
          expect(r, 422, "validation_failed", `malformed ${field}`);
          assert.ok(field in (r.body.fields ?? {}), `${field}: ${r.text}`);
        }
        const results = await Promise.all(Array.from({ length: 4 }, () => call(adminCookie, "POST", "/api/platform/workspaces", body)));
        for (const r of results) assert.equal(r.status, 200, r.text);
        assert.equal(new Set(results.map((r) => r.body.workspaceId)).size, 1, "every caller gets the same workspace");
        const winners = results.filter((r) => r.body.created);
        assert.equal(winners.length, 1, "exactly one call created it");
        assert.deepEqual(results.filter((r) => r.body.inviteUrl).length, 1, "the owner link is returned once");
        wsP = winners[0].body.workspaceId;
        firstToken = tokenOf(winners[0].body.inviteUrl);
        const repeat = await call(adminCookie, "POST", "/api/platform/workspaces", body);
        assert.deepEqual(repeat.body, { ok: true, workspaceId: wsP, created: false, inviteUrl: null });
        expect(await call(adminCookie, "POST", "/api/platform/workspaces", { ...body, name: "Someone Else" }), 409, "conflict", "same key, other inputs");
        expect(await call(adminCookie, "POST", "/api/platform/workspaces", { ...body, provisioningKey: `p6-other-${run}` }), 409, "conflict", "slug taken");

        const rows = await db.query<{ n: number; stages: number; creator: string }>(
          `select count(*)::int n, (select count(*)::int from public.pipeline_stages where workspace_id = $2) stages,
                  max(created_by::text) creator
           from public.workspaces where provisioning_key = $1`, [body.provisioningKey, wsP]);
        assert.deepEqual(rows.rows[0], { n: 1, stages: 12, creator: admin.id });
        const provAudit = (await platformAudit(wsP)).filter((a) => a.action === "workspace.provisioned");
        assert.deepEqual(provAudit.map((a) => a.actor_id), [admin.id]);

        const detail = await call(adminCookie, "GET", `/api/platform/workspaces/${wsP}`);
        assert.equal(detail.status, 200, detail.text);
        assert.deepEqual([detail.body.workspace.name, detail.body.workspace.status, detail.body.workspace.canRotateBootstrap,
          detail.body.workspace.ownerAcquiredAt, detail.body.workspace.members], [BUSINESS, "active", true, null, { owner: 0, admin: 0, employee: 0 }]);
        assert.ok(detail.body.workspace.openOwnerInvitation?.expiresAt);
        assert.equal(TOKEN_LIKE.test(detail.text), false, "no invitation token or hash in the detail");
      });

      test("replacing the owner invitation: reason required, old link revoked, owner joins, then refused", async () => {
        const path = `/api/platform/workspaces/${wsP}/bootstrap-invitation`;
        expect(await call(adminCookie, "POST", path, {}), 422, "validation_failed", "no reason");
        expect(await call(adminCookie, "POST", path, { reason: "lost" }), 422, "validation_failed", "short reason");
        expect(await call(adminCookie, "POST", `/api/platform/workspaces/${"0".repeat(8)}-0000-4000-8000-000000000000/bootstrap-invitation`,
          { reason: REASON }), 404, "not_found", "unknown workspace");
        const rotated = await call(adminCookie, "POST", path, { reason: REASON });
        assert.equal(rotated.status, 200, rotated.text);
        const token = tokenOf(rotated.body.inviteUrl);
        assert.notEqual(token, firstToken);
        assert.equal(rotated.body.revokedInvitations, 1);
        expect(await appFetch(app, `/api/invitations/${firstToken}`), 410, "invitation_revoked", "old link");

        const joined = await appFetch(app, `/api/invitations/${token}/accept`, { method: "POST", json: { password: "Local-p6-owner-pass-1" } });
        assert.equal(joined.status, 200, joined.text);
        assert.equal(joined.body.workspace?.id, wsP);
        pOwnerCookie = cookieHeader(joined.setCookies);
        expect(await call(adminCookie, "POST", path, { reason: REASON }), 409, "conflict", "after the owner joined");
        const detail = await call(adminCookie, "GET", `/api/platform/workspaces/${wsP}`);
        assert.deepEqual([detail.body.workspace.canRotateBootstrap, detail.body.workspace.openOwnerInvitation, detail.body.workspace.members.owner],
          [false, null, 1]);
        assert.ok(detail.body.workspace.ownerAcquiredAt);
        const rot = (await platformAudit(wsP)).filter((a) => a.action === "workspace.bootstrap_invitation_rotated");
        assert.deepEqual(rot.map((a) => [a.actor_id, a.reason]), [[admin.id, REASON]]);
        assert.equal(TOKEN_LIKE.test(JSON.stringify(rot.map((a) => a.metadata))), false, "no token in the audit metadata");

        const c = await call(pOwnerCookie, "POST", "/api/contacts", { firstName: "Paula", lastName: "Synthetic" });
        assert.equal(c.status, 200, c.text);
        pContact = c.body.contact.id;
      });

      test("search, status filter, and keyset paging with exact totals", async () => {
        const made: string[] = [];
        for (let i = 0; i < 3; i++) {
          const r = await call(adminCookie, "POST", "/api/platform/workspaces", {
            provisioningKey: `p6-page-${run}-${i}`, name: `P6 Page ${i} (synthetic)`, slug: `p6-page-${run}-${i}`, ownerEmail: email(`p6-page-${i}`) });
          assert.equal(r.status, 200, r.text);
          made.push(r.body.workspaceId);
        }
        const pages: string[][] = [];
        const totals = new Set<number>();
        let cursor: string | null = null;
        do {
          const r: R = await call(adminCookie, "GET", `/api/platform/workspaces?q=p6-page-${run}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          assert.equal(r.status, 200, r.text);
          pages.push(r.body.items.map((w: { id: string }) => w.id));
          totals.add(r.body.total);
          cursor = r.body.nextCursor;
        } while (cursor);
        assert.deepEqual(pages.map((p) => p.length), [2, 1]);
        assert.deepEqual(pages.flat(), [...made].reverse(), "newest first, no overlap, nothing skipped");
        assert.deepEqual([...totals], [3]);
        const byEmail = await call(adminCookie, "GET", `/api/platform/workspaces?q=${encodeURIComponent(email("p6-page-1"))}`);
        assert.deepEqual(byEmail.body.items.map((w: { id: string }) => w.id), [made[1]]);
        const literal = await call(adminCookie, "GET", `/api/platform/workspaces?q=${encodeURIComponent("p6%page")}`);
        assert.equal(literal.body.total, 0, "% is matched literally");
        const suspendedOnly = await call(adminCookie, "GET", `/api/platform/workspaces?q=p6-page-${run}&status=suspended`);
        assert.deepEqual([suspendedOnly.body.total, suspendedOnly.body.items], [0, []]);
        const one = (await call(adminCookie, "GET", `/api/platform/workspaces?q=p6-alpha-${run}`)).body.items[0];
        assert.deepEqual([one.id, one.memberCount, one.ownerJoined], [wsP, 1, true]);
        expect(await call(adminCookie, "GET", "/api/platform/workspaces?limit=101"), 422, "validation_failed", "limit");
        expect(await call(adminCookie, "GET", "/api/platform/workspaces?cursor=bogus"), 422, "validation_failed", "cursor");
        expect(await call(adminCookie, "GET", "/api/platform/workspaces?status=deleted"), 422, "validation_failed", "status");
      });

      test("support grants: read reads only, write is attributed, other workspaces stay 404, ending access applies on the next request", async () => {
        const read = await grantTo(wsP, "read");
        try {
          const list = await call(adminCookie, "GET", "/api/contacts");
          assert.equal(list.status, 200, list.text);
          assert.deepEqual(list.body.items.map((c: { id: string }) => c.id), [pContact]);
          expect(await call(adminCookie, "POST", "/api/contacts", { firstName: "Nope" }), 403, "forbidden", "write under a read grant");
          expect(await call(adminCookie, "GET", `/api/contacts/${contactA}`), 404, "not_found", "another workspace's contact");
          const page = await appFetch(app, "/dashboard", { cookie: adminCookie });
          assert.equal(page.status, 200);
          const banner = new RegExp(`Platform support access:.*${BUSINESS.replace(/[()]/g, "\\$&")}.*Read-only.*expires.*\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}.*UTC`);
          assert.match(page.text.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""), banner, "the banner names the workspace, mode, and expiry");
          const active = await call(adminCookie, "GET", "/api/platform/access");
          assert.deepEqual(active.body.items.map((g: { id: string; mine: boolean }) => [g.id, g.mine]), [[read.id, true]]);

          expect(await call(adminCookie, "DELETE", `/api/platform/access/${read.id}`, {}), 422, "validation_failed", "end without reason");
          const ended = await call(adminCookie, "DELETE", `/api/platform/access/${read.id}`, { reason: "Customer issue resolved" });
          assert.equal(ended.status, 200, ended.text);
          expect(await call(adminCookie, "GET", "/api/contacts"), 403, "no_active_workspace", "next request after ending");
          expect(await call(adminCookie, "DELETE", `/api/platform/access/${read.id}`, { reason: "Customer issue resolved" }), 404, "not_found", "end twice");
          const history = await call(adminCookie, "GET", "/api/platform/access?include=all");
          const row = history.body.items.find((g: { id: string }) => g.id === read.id);
          assert.deepEqual([row.active, Boolean(row.revokedAt), row.reason], [false, true, REASON]);
          assert.deepEqual((await call(adminCookie, "GET", "/api/platform/access")).body.items, []);
        } finally {
          await endGrant(read.id);
        }

        const write = await grantTo(wsP, "write");
        try {
          const made = await call(adminCookie, "POST", "/api/contacts", { firstName: "Support", lastName: "Written" });
          assert.equal(made.status, 200, made.text);
          expect(await call(adminCookie, "PATCH", `/api/contacts/${contactA}`, { firstName: "Hijack" }), 404, "not_found", "write to another workspace");
          const audit = await db.query(
            "select actor_id, actor_kind, action, target from public.workspace_audit_log where grant_id = $1 and action = 'contacts.insert'", [write.id]);
          assert.deepEqual(audit.rows, [{ actor_id: admin.id, actor_kind: "platform_admin", action: "contacts.insert", target: made.body.contact.id }]);
          const contactRow = await db.query("select created_by from public.contacts where id = $1", [made.body.contact.id]);
          assert.equal(contactRow.rows[0].created_by, admin.id);
          const page = await appFetch(app, "/contacts", { cookie: adminCookie });
          assert.match(page.text.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""), /Platform support access:.*Read and write/);
        } finally {
          await endGrant(write.id);
        }
        const contactsA = await db.query("select first_name from public.contacts where workspace_id = $1 and first_name = 'Hijack'", [wsA]);
        assert.equal(contactsA.rowCount, 0);

        const auditApi = await call(adminCookie, "GET", `/api/platform/workspaces/${wsP}/audit?limit=100`);
        assert.equal(auditApi.status, 200, auditApi.text);
        const items = auditApi.body.items as { action: string; reason: string | null; actorEmail: string; metadata: any; workspaceId: string }[];
        const granted = items.filter((a) => a.action === "access.granted");
        const revoked = items.filter((a) => a.action === "access.revoked");
        assert.equal(granted.length, 2);
        assert.ok(granted.every((a) => a.actorEmail === admin.email && a.reason === REASON && a.workspaceId === wsP));
        assert.deepEqual(revoked.map((a) => [a.reason, a.metadata.grant_id]).sort(),
          [["Customer issue resolved", read.id], ["Support session finished", write.id]].sort());
        assert.equal(TOKEN_LIKE.test(auditApi.text.replace(/"nextCursor":"[^"]*"/, "")), false, "no credentials in the audit view");
        const wsSide = await db.query<{ action: string; metadata: any }>(
          "select action, metadata from public.workspace_audit_log where workspace_id = $1 and action = 'platform.access_revoked' order by id", [wsP]);
        assert.deepEqual(wsSide.rows.map((r) => r.metadata.reason), ["Customer issue resolved", "Support session finished"]);
      });

      test("a one-minute grant created in the console expires by the clock on the next request", async () => {
        const g = await grantTo(wsP, "read", 1);
        try {
          assert.equal((await call(adminCookie, "GET", "/api/contacts")).status, 200);
          const wait = Date.parse(g.expiresAt) - Date.now() + 1500;
          assert.ok(wait > 0 && wait < 65_000, `expiry in ${wait} ms`);
          await new Promise((r) => setTimeout(r, wait));
          expect(await call(adminCookie, "GET", "/api/contacts"), 403, "no_active_workspace", "after expiry");
          assert.equal((await call(adminCookie, "GET", "/api/platform/access")).body.items.length, 0);
          const hist = (await call(adminCookie, "GET", "/api/platform/access?include=all")).body.items.find((x: { id: string }) => x.id === g.id);
          assert.deepEqual([hist.active, hist.revokedAt], [false, null], "expired, not revoked");
          expect(await call(adminCookie, "DELETE", `/api/platform/access/${g.id}`, { reason: "Ending an expired grant" }), 404, "not_found",
            "an expired grant cannot be ended");
          const ended = await db.query("select count(*)::int n from public.platform_audit_log where action = 'access.revoked' and metadata ->> 'grant_id' = $1", [g.id]);
          assert.equal(ended.rows[0].n, 0, "no end-of-access entry for a grant that had already expired");
        } finally {
          if (Date.parse(g.expiresAt) > Date.now()) await endGrant(g.id);
        }
      });

      test("suspension from the console: members 423, read grants still read, write grants 423, reactivation restores everything", async () => {
        const write = await grantTo(wsP, "write");
        let reactivated = false;
        try {
          expect(await call(adminCookie, "POST", `/api/platform/workspaces/${wsP}/suspend`, {}), 422, "validation_failed", "suspend without reason");
          const s = await call(adminCookie, "POST", `/api/platform/workspaces/${wsP}/suspend`, { reason: REASON });
          assert.equal(s.status, 200, s.text);
          assert.deepEqual([s.body.workspace.status, s.body.workspace.suspendedReason], ["suspended", REASON]);
          expect(await call(pOwnerCookie, "GET", "/api/contacts"), 423, "workspace_suspended", "owner during suspension");
          expect(await call(pOwnerCookie, "POST", "/api/contacts", { firstName: "Blocked" }), 423, "workspace_suspended", "owner write");
          // A write grant on a suspended workspace confers nothing (active_grant_id), so it is no workspace at all.
          expect(await call(adminCookie, "POST", "/api/contacts", { firstName: "Blocked" }), 403, "no_active_workspace", "existing write grant");
          expect(await call(adminCookie, "GET", "/api/contacts"), 403, "no_active_workspace", "existing write grant read");
          assert.equal((await db.query("select count(*)::int n from public.contacts where workspace_id = $1 and first_name = 'Blocked'", [wsP])).rows[0].n, 0);
          const newWrite = await call(adminCookie, "POST", `/api/platform/workspaces/${wsP}/access`, { mode: "write", reason: REASON, durationMinutes: 5 });
          expect(newWrite, 423, "workspace_suspended", "new write grant");
          await endGrant(write.id);
          const read = await grantTo(wsP, "read", 5);
          try {
            const list = await call(adminCookie, "GET", "/api/contacts");
            assert.equal(list.status, 200, list.text);
            assert.ok(list.body.items.some((c: { id: string }) => c.id === pContact));
            const page = await appFetch(app, "/dashboard", { cookie: adminCookie });
            assert.match(page.text.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""), /Platform support access:.*\(suspended\).*Read-only/);
          } finally {
            await endGrant(read.id);
          }
          const filtered = await call(adminCookie, "GET", `/api/platform/workspaces?status=suspended&q=p6-alpha-${run}`);
          assert.deepEqual(filtered.body.items.map((w: { id: string }) => w.id), [wsP]);

          expect(await call(adminCookie, "POST", `/api/platform/workspaces/${wsP}/reactivate`, { reason: "x" }), 422, "validation_failed", "short reason");
          const r = await call(adminCookie, "POST", `/api/platform/workspaces/${wsP}/reactivate`, { reason: "Billing resolved with the owner" });
          assert.equal(r.status, 200, r.text);
          reactivated = true;
          assert.equal(r.body.workspace.status, "active");
          const back = await call(pOwnerCookie, "GET", "/api/contacts");
          assert.equal(back.status, 200, back.text);
          assert.ok(back.body.items.some((c: { id: string }) => c.id === pContact), "records survive suspension");
          const actions = (await platformAudit(wsP)).filter((a) => a.action.startsWith("workspace.") && a.action !== "workspace.provisioned");
          assert.deepEqual(actions.map((a) => [a.action, a.actor_id, a.reason]).slice(-2),
            [["workspace.suspended", admin.id, REASON], ["workspace.reactivated", admin.id, "Billing resolved with the owner"]]);
        } finally {
          await endGrant(write.id);
          if (!reactivated) await call(adminCookie, "POST", `/api/platform/workspaces/${wsP}/reactivate`, { reason: "stack test cleanup reactivation" });
        }
      });

      test("sensitive actions re-check the session: a logged-out AAL2 cookie is refused and nothing is recorded", async () => {
        const second = await verifyWithApp(await appLogin(app, admin));
        const before = (await db.query("select count(*)::int n from public.platform_audit_log where actor_id = $1", [admin.id])).rows[0].n;
        assert.equal((await call(second, "POST", "/api/auth/logout")).status, 200);
        const r = await call(second, "POST", `/api/platform/workspaces/${wsP}/suspend`, { reason: REASON });
        assert.ok(r.status === 401, `${r.status} ${r.text}`);
        const after = (await db.query("select count(*)::int n from public.platform_audit_log where actor_id = $1", [admin.id])).rows[0].n;
        assert.equal(after, before);
        assert.equal((await db.query("select status from public.workspaces where id = $1", [wsP])).rows[0].status, "active");
      });

      test("browser: AAL1 admin is sent to MFA, enrols in the UI, provisions, opens support access, sees the banner, ends it", async () => {
        const shots = mkdtempSync(join(tmpdir(), "fna-p6-browser-"));
        const base = app.url.replace("//127.0.0.1:", "//localhost:");
        const bAdmin = await signUp(env, email("p6-browser-admin"), "P6 Browser Admin");
        await db.query("insert into public.platform_admins (user_id) values ($1)", [bAdmin.id]);
        const browser = await launchBrowser();
        try {
          const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
          ctx.setDefaultTimeout(20_000);
          await ctx.addInitScript("window.__name = (f) => f");
          const page = await ctx.newPage();
          await page.goto(`${base}/login`);
          await page.fill("#email", bAdmin.email);
          await page.fill("#password", bAdmin.password);
          await page.click("button[type=submit]");
          await page.waitForURL(/\/no-access$/);
          await page.getByRole("link", { name: "Verify authenticator for platform administration" }).click();
          await page.waitForURL(/\/platform\/mfa$/);
          await page.getByRole("button", { name: "Set up authenticator app" }).click();
          const key = await page.locator("#mfa-secret").inputValue();
          await page.getByRole("img", { name: "Authenticator QR code" }).waitFor();
          await page.screenshot({ path: join(shots, "mfa-enrol.png"), fullPage: true });
          await page.fill("#mfa-code", String((Number(totp(key)) + 1) % 1_000_000).padStart(6, "0"));
          await page.getByRole("button", { name: "Verify" }).click();
          await page.getByRole("alert").getByText("That code is not valid.", { exact: false }).waitFor();
          await page.fill("#mfa-code", totp(key));
          await page.getByRole("button", { name: "Verify" }).click();
          await page.waitForURL(/\/platform$/);
          await page.getByRole("heading", { name: "Workspaces", exact: true }).waitFor();
          assert.equal(await page.locator(".sidebar").count(), 0, "no client sidebar in the console");

          await page.getByRole("button", { name: "Provision workspace" }).click();
          await page.fill("#prov-name", "P6 Browser Business");
          assert.equal(await page.locator("#prov-slug").inputValue(), "p6-browser-business");
          await page.fill("#prov-slug", `p6-browser-${run}`);
          await page.fill("#prov-owner", email("p6-browser-owner"));
          await page.fill("#prov-key", `p6-browser-${run}`);
          await page.getByRole("dialog").getByRole("button", { name: "Provision" }).click();
          await page.getByText("This link is shown only once.", { exact: false }).waitFor();
          const link = await page.locator("#platform-invite-link").inputValue();
          assert.match(link, /\/invite\/[0-9a-f]{64}$/);
          await page.screenshot({ path: join(shots, "provisioned.png"), fullPage: true });
          await page.getByRole("button", { name: "Done" }).click();

          await page.fill("#ws-search", `p6-alpha-${run}`);
          await page.getByRole("link", { name: BUSINESS }).click();
          await page.waitForURL(new RegExp(`/platform/workspaces/${wsP}$`));
          await page.getByText("1 active member(s)", { exact: false }).waitFor();
          assert.equal(await page.getByRole("button", { name: "Replace owner invitation" }).count(), 0, "owner already joined");
          await page.screenshot({ path: join(shots, "workspace-detail.png"), fullPage: true });
          await page.selectOption("#grant-mode", "read");
          await page.selectOption("#grant-duration", "15");
          await page.fill("#grant-reason", "short");
          await page.getByRole("button", { name: "Start support access" }).click();
          await page.getByText("Give a reason of at least 10 characters.").waitFor();
          await page.fill("#grant-reason", "Browser support check for P6");
          await page.getByRole("button", { name: "Start support access" }).click();
          await page.waitForURL(/\/dashboard$/);
          const banner = page.getByRole("status", { name: "Platform support access" });
          await banner.getByText(/P6 Alpha \(synthetic\) · Read-only · expires \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(1[45] min left\)/).waitFor();
          await page.screenshot({ path: join(shots, "support-banner.png"), fullPage: true });
          await banner.getByRole("button", { name: "End access" }).click();
          await page.getByRole("dialog").getByRole("button", { name: "End access" }).click();
          await page.waitForURL(/\/platform$/);
          await page.getByText("No support access is active.").waitFor();
          const live = await db.query("select count(*)::int n from public.platform_access_grants where admin_user_id = $1 and revoked_at is null and expires_at > now()", [bAdmin.id]);
          assert.equal(live.rows[0].n, 0);

          await page.getByRole("link", { name: "Audit log" }).click();
          await page.waitForURL(/\/platform\/audit$/);
          await page.getByText("Browser support check for P6").first().waitFor();
          await page.screenshot({ path: join(shots, "audit.png"), fullPage: true });
          assert.equal(TOKEN_LIKE.test(await page.content()), false, "no tokens on the audit page");
          console.log(`P6 browser screenshots: ${shots}`);
        } catch (err) {
          let n = 0;
          for (const c of browser.contexts()) {
            for (const p of c.pages()) {
              console.error(`P6 browser page ${n}: ${p.url()}`);
              await p.screenshot({ path: join(shots, `failure-${n++}.png`), fullPage: true }).catch(() => undefined);
            }
          }
          console.error(`P6 browser flow failed (screenshots so far: ${shots}):`, err);
          throw err;
        } finally {
          await browser.close().catch(() => undefined);
        }
      });
    });

    // Last: it may use up the local sign-in rate limit for this IP. The local stack did not rate-limit
    // these attempts in practice; the 429 → rate_limited mapping is proven in tests/p2-auth.test.ts.
    test("AUTH-1: repeated failed sign-ins only ever answer generic 401 or 429 rate_limited", async () => {
      const generic = { ok: false, error: "Invalid credentials", code: "unauthenticated" };
      const limited = { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" };
      for (let i = 0; i < 40; i++) {
        const r = await appFetch(app, "/api/auth/login", { method: "POST", json: { email: outsider.email, password: `wrong-${i}` } });
        assert.ok(r.status === 401 || r.status === 429, `attempt ${i}: ${r.status} ${r.text.slice(0, 120)}`);
        assert.deepEqual(r.body, r.status === 401 ? generic : limited);
      }
    });

    test("NET-1: the app attempted no outbound connection, and the stack has no email or SMS route", async () => {
      assert.deepEqual(app.outbound(), [], "non-local connections attempted by the app");
      const routes = messageRoutes(stack.project);
      assert.deepEqual(routes.filter((r) => r !== "local_smtp"), [], "GoTrue has no SMTP or SMS provider configured");
      if (env.mailUrl) assert.equal(await capturedMailCount(env), 0, "messages captured by the local mail catcher");
      else assert.equal(routes.includes("local_smtp"), false);
    });
  });
});

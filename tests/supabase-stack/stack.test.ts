// End-to-end checks against a disposable local Supabase stack. Every isolation assertion uses a real
// GoTrue identity and its own JWT through PostgREST or Storage. The superuser connection is used only
// for setup that stands in for the platform-admin bootstrap script and for verifying outcomes.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type pg from "pg";
import {
  adminDb, appFetch, appLogin, cookieHeader, jwtPayload, readSessionCookie, rest, rpc, serviceRest, sessionCookie,
  signJwt, signUp, startApp, startStack, storage, upgradeToAal2, upgradeToAal2Session,
  type App, type HttpResult, type Identity, type Stack, type StackEnv,
} from "./stack";

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
  await voidRpc(platformAal2, "platform_revoke_access", { p_grant_id: id });
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
      const r = await rpc(env, platformAal2, "platform_revoke_access", { p_grant_id: id });
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
      // Spec §5.1: reads trust the verified access token until it expires, so a replayed cookie of a
      // logged-out session still reads (observed). Sensitive mutations re-check with getUser() and
      // refuse it (platform Storage endpoint test). Update §16 if this ever changes.
      const replayApi = await appFetch(app, "/api/tenant/config", { cookie: throwaway });
      assert.equal(replayApi.status, 200, `replayed cookie after logout: ${replayApi.status}`);
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
      for (const path of ["/api/dashboard/summary", "/api/tenant/config", "/api/workspaces", "/api/events"]) {
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
      const owner = await appFetch(app, "/api/events", { cookie });
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
      const revoke = (id: string) => voidRpc(aal2.access_token, "platform_revoke_access", { p_grant_id: id });

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
        const del = await appFetch(app, "/api/platform/workspace-logo?ext=png", { method: "DELETE", cookie: adminCookie });
        assert.equal(del.status, 200, del.text);
        const left = await db.query("select count(*)::int n from storage.objects where bucket_id = 'workspace-assets' and name = $1", [logoPath]);
        assert.equal(left.rows[0].n, 0);

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
          { p_request_id: ok.body.requestId, p_actor_id: admin.id });
        assert.ok(fabricate.status === 401 || fabricate.status === 403, `direct completion: ${fabricate.status} ${fabricate.text}`);
        const oldSignature = await rpc(env, aal2.access_token, "platform_storage_change_finished",
          { p_request_id: ok.body.requestId, p_succeeded: true });
        assert.equal(oldSignature.status, 404, oldSignature.text);
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
        await db.query("revoke execute on function public.platform_storage_change_finished(bigint, uuid) from service_role");
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
          await db.query("grant execute on function public.platform_storage_change_finished(bigint, uuid) to service_role");
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
        const auditCount = (await storageAudit(writeGrant)).length;

        // A password (AAL1) session of the same platform admin is not a platform admin.
        const aal1Cookie = await appLogin(app, admin);
        const aal1 = await put(aal1Cookie);
        assert.equal(aal1.status, 403, aal1.text);

        // Sensitive mutations re-check the session with the Auth server (§5.1): once this AAL2
        // session is logged out, its still-unexpired cookie is refused and nothing is recorded.
        assert.equal((await appFetch(app, "/api/auth/logout", { method: "POST", cookie: adminCookie })).status, 200);
        const loggedOut = await put(adminCookie);
        assert.deepEqual([loggedOut.status, loggedOut.body.code], [401, "unauthenticated"], loggedOut.text);
        assert.equal((await storageAudit(writeGrant)).length, auditCount, "a logged-out session records nothing");
      } finally {
        await revoke(writeGrant);
      }
      const total = (await storageAudit(writeGrant)).length;
      const afterRevoke = await put(adminCookie);
      assert.equal(afterRevoke.status, 403, afterRevoke.text);
      assert.equal((await storageAudit(writeGrant)).length, total, "nothing is recorded after revocation");
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
  });
});

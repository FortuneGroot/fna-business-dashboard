// End-to-end checks against a disposable local Supabase stack. Every isolation assertion uses a real
// GoTrue identity and its own JWT through PostgREST or Storage. The superuser connection is used only
// for setup that stands in for the platform-admin bootstrap script and for verifying outcomes.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import type pg from "pg";
import {
  adminDb, jwtPayload, rest, rpc, serviceRest, signJwt, signUp, startStack, storage, upgradeToAal2,
  type HttpResult, type Identity, type Stack, type StackEnv,
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
});

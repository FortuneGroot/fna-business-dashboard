// A2 operator CLI (scripts/bootstrap-platform-admin.ts) against a disposable local Supabase stack:
// the real script as a child process, with real GoTrue users and MFA factors. Never pointed at a
// hosted project. The superuser connection only verifies outcomes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { adminDb, rpc, signUp, startStack, upgradeToAal2Session, type Identity, type Stack, type StackEnv } from "./stack";

const ROOT = join(__dirname, "..", "..");
const run = Date.now().toString(36);
const email = (who: string) => `${who}-${run}@example.test`;

let stack: Stack;
let env: StackEnv;
let db: pg.Client;

function cli(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/bootstrap-platform-admin.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, SUPABASE_URL: env.apiUrl, SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(out.includes(env.serviceRoleKey), false, "the CLI never prints the service-role key");
  return { code: r.status, out };
}

async function passwordSession(user: Identity): Promise<string> {
  const r = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: env.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  return body.access_token;
}

const status = (b: { listed: boolean; active: boolean }) => ({ listed: b.listed, active: b.active });
const adminCount = async () => Number((await db.query("select count(*) n from public.platform_admins")).rows[0].n);
const auditActions = async (userId: string) =>
  (await db.query<{ action: string }>(
    "select action from public.platform_audit_log where metadata->>'user_id' = $1 order by id", [userId])).rows.map((r) => r.action);

describe("A2 platform-admin bootstrap CLI on a disposable local stack", () => {
  let george: Identity;
  let ops: Identity;

  before(async () => {
    stack = startStack();
    env = stack.env;
    db = await adminDb(env);
    george = await signUp(env, email("george"), "George (synthetic)");
    ops = await signUp(env, email("ops"), "Ops (synthetic)");
  });
  after(async () => {
    await db?.end();
    stack?.stop();
  });

  test("grant registers the platform admin once, audited; console access still needs AAL2", async () => {
    assert.equal(await adminCount(), 0);
    const first = cli("grant", "--email", george.email, "--env", "local");
    assert.equal(first.code, 0, first.out);
    const again = cli("grant", "--email", george.email.toUpperCase(), "--env", "local");
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already a platform admin/);
    assert.equal(await adminCount(), 1);
    assert.deepEqual(await auditActions(george.id), ["platform.admin_granted"]);
    assert.deepEqual(status((await rpc(env, george.token, "platform_status")).body), { listed: true, active: false });
    const aal2 = await upgradeToAal2Session(env, george);
    assert.equal((await rpc(env, aal2.access_token, "platform_status")).body.active, true);
  });

  test("refusals: unknown user, non-local env against this stack, and the last admin", async () => {
    const unknown = cli("grant", "--email", email("nobody"), "--env", "local");
    assert.equal(unknown.code, 3, unknown.out);
    for (const target of ["staging", "production"]) {
      const r = cli("grant", "--email", ops.email, "--env", target);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /refuses a loopback target/);
    }
    const last = cli("revoke", "--email", george.email, "--env", "local", "--reason", "Testing the last-admin guard");
    assert.equal(last.code, 4, last.out);
    assert.equal(await adminCount(), 1);
  });

  test("remove-mfa is the device-loss recovery path: factors removed, audited, re-enrolment restores access", async () => {
    const factors = async () => Number((await db.query("select count(*) n from auth.mfa_factors where user_id = $1", [george.id])).rows[0].n);
    assert.equal(await factors(), 1);
    const r = cli("remove-mfa", "--email", george.email, "--env", "local", "--reason", "Lost phone; identity confirmed by call");
    assert.equal(r.code, 0, r.out);
    assert.equal(await factors(), 0);
    const audit = await db.query<{ reason: string; metadata: { factor_ids: string[] } }>(
      "select reason, metadata from public.platform_audit_log where action = 'platform.mfa_factors_removed' and metadata->>'user_id' = $1", [george.id]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].reason, "Lost phone; identity confirmed by call");
    assert.equal(audit.rows[0].metadata.factor_ids.length, 1);

    const fresh = await passwordSession(george);
    assert.deepEqual(status((await rpc(env, fresh, "platform_status")).body), { listed: true, active: false }, "AAL1 until re-enrolled");
    const reenrolled = await upgradeToAal2Session(env, { ...george, token: fresh });
    assert.equal((await rpc(env, reenrolled.access_token, "platform_status")).body.active, true);
  });

  test("revoke with a second admin present removes the first, audited with the reason; list is read-only", async () => {
    assert.equal(cli("grant", "--email", ops.email, "--env", "local").code, 0);
    const r = cli("revoke", "--email", george.email, "--env", "local", "--reason", "Handover to ops complete");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual((await db.query("select user_id from public.platform_admins")).rows.map((x) => x.user_id), [ops.id]);
    assert.deepEqual(await auditActions(george.id), ["platform.admin_granted", "platform.mfa_factors_removed", "platform.admin_revoked"]);
    const list = cli("list", "--env", "local");
    assert.equal(list.code, 0, list.out);
    assert.match(list.out, new RegExp(ops.id));
    assert.equal(list.out.includes(george.id), false);
  });
});

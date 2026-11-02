import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { adminCount, asServiceRole, asUser, createUser, freshDb, rpc, type TestUser } from "./harness";

// M22: platform-admin grants and revocations are atomic with their audit row, and no path can
// leave zero platform admins. Concurrency is covered on real PostgreSQL (tests/db-real).

type Db = Awaited<ReturnType<typeof freshDb>>;
const META = JSON.stringify({ via: "test", env: "local" });
const LAST = /last_platform_admin/;

let db: Db;
let seq = 0;
const user = async (aal: "aal1" | "aal2" = "aal1"): Promise<TestUser> => createUser(db, `guard-${++seq}@example.test`, aal);
const admins = () => adminCount(db, "select count(*) n from public.platform_admins");
const isAdmin = (u: TestUser) => adminCount(db, "select count(*) n from public.platform_admins where user_id = $1", [u.id]);
const audits = (action: string, u: TestUser) =>
  adminCount(db, "select count(*) n from public.platform_audit_log where action = $1 and metadata->>'user_id' = $2", [action, u.id]);
const grant = (u: TestUser) => asServiceRole(db, (q) => rpc<{ changed: boolean }>(q, "platform_admin_grant", [u.id, META]));
const revoke = (u: TestUser, reason = "Rotation complete") =>
  asServiceRole(db, (q) => rpc<{ changed: boolean }>(q, "platform_admin_revoke", [u.id, reason, META]));

/** Makes every platform_audit_log insert with `action` fail, for the duration of `fn`. */
async function withFailingAudit(action: string, fn: () => Promise<void>) {
  await db.exec(`
    create function public.test_fail_audit() returns trigger language plpgsql as $$
    begin
      if new.action = '${action}' then raise exception 'audit insert failed (test)'; end if;
      return new;
    end $$;
    create trigger test_fail_audit before insert on public.platform_audit_log
      for each row execute function public.test_fail_audit();`);
  try {
    await fn();
  } finally {
    await db.exec("drop trigger test_fail_audit on public.platform_audit_log; drop function public.test_fail_audit();");
  }
}

before(async () => {
  db = await freshDb();
});

describe("M22 platform-admin guard (PGlite)", () => {
  test("grant adds the admin and its audit row once; a repeat changes nothing", async () => {
    const a = await user();
    assert.equal((await grant(a)).changed, true);
    assert.equal((await grant(a)).changed, false);
    assert.equal(await isAdmin(a), 1);
    assert.equal(await audits("platform.admin_granted", a), 1);
    const row = (await db.query<{ actor_id: string | null; metadata: Record<string, string> }>(
      "select actor_id, metadata from public.platform_audit_log where action = 'platform.admin_granted' and metadata->>'user_id' = $1", [a.id])).rows[0];
    assert.deepEqual([row.actor_id, row.metadata.via, row.metadata.env], [null, "test", "local"]);
  });

  test("an audit failure rolls back the grant: no admin row, no audit row", async () => {
    const b = await user();
    await withFailingAudit("platform.admin_granted", async () => {
      await assert.rejects(grant(b), /audit insert failed/);
    });
    assert.equal(await isAdmin(b), 0);
    assert.equal(await audits("platform.admin_granted", b), 0);
  });

  test("an audit failure rolls back the revocation: the admin remains", async () => {
    const c = await user();
    await grant(c);
    const before = await admins();
    assert.ok(before >= 2);
    await withFailingAudit("platform.admin_revoked", async () => {
      await assert.rejects(revoke(c), /audit insert failed/);
    });
    assert.equal(await isAdmin(c), 1);
    assert.equal(await admins(), before);
    assert.equal(await audits("platform.admin_revoked", c), 0);
  });

  test("revoke removes one admin with its audit row and the reason; a non-admin is a no-op", async () => {
    const d = await user();
    await grant(d);
    assert.equal((await revoke(d, "Handover complete")).changed, true);
    assert.equal(await isAdmin(d), 0);
    const reason = (await db.query<{ reason: string }>(
      "select reason from public.platform_audit_log where action = 'platform.admin_revoked' and metadata->>'user_id' = $1", [d.id])).rows[0].reason;
    assert.equal(reason, "Handover complete");
    assert.equal((await revoke(d)).changed, false);
    await assert.rejects(revoke(d, "   x  "), /validation_failed/);
  });

  test("the last platform admin cannot be removed by the function, a direct delete, a cascade, or truncate", async () => {
    const remaining = (await db.query<{ user_id: string }>("select user_id from public.platform_admins")).rows.map((r) => r.user_id);
    for (const id of remaining.slice(1)) await asServiceRole(db, (q) => rpc(q, "platform_admin_revoke", [id, "Reduce to one admin", META]));
    assert.equal(await admins(), 1);
    const [last] = (await db.query<{ user_id: string }>("select user_id from public.platform_admins")).rows;
    const lastUser = { id: last.user_id, email: "", aal: "aal2" as const };

    await assert.rejects(revoke(lastUser), LAST);
    await assert.rejects(asServiceRole(db, (q) => q.query("delete from public.platform_admins where user_id = $1", [last.user_id])), LAST);
    await assert.rejects(db.query("delete from auth.users where id = $1", [last.user_id]), LAST);
    await assert.rejects(db.query("truncate public.platform_admins cascade"), LAST);
    assert.equal(await admins(), 1);

    const second = await user();
    await grant(second);
    await assert.rejects(asServiceRole(db, (q) => q.query("delete from public.platform_admins")), LAST, "deleting every admin at once");
    assert.equal(await admins(), 2);
    await asServiceRole(db, (q) => q.query("delete from public.platform_admins where user_id = $1", [second.id]));
    assert.equal(await admins(), 1);
  });

  test("an admin whose support grant is referenced by a workspace audit row is revoked; the grant ends and the history stays", async () => {
    const p = await user("aal2");
    await grant(p);
    const owner = await user();
    await asUser(db, p, (q) => rpc(q, "platform_provision_workspace", [`synthetic-guard-${seq}`, "Guard Fixture (synthetic)", `guard-fixture-${seq}`, owner.email]));
    const ws = (await db.query<{ id: string }>("select id from public.workspaces where provisioning_key = $1", [`synthetic-guard-${seq}`])).rows[0].id;
    await asUser(db, p, (q) => rpc(q, "platform_grant_access", [ws, "read", "Support ticket 123 (synthetic)", 30]));
    const grantId = (await db.query<{ id: string }>("select id from public.platform_access_grants where admin_user_id = $1", [p.id])).rows[0].id;
    await db.query(
      "insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action) values ($1, $2, 'platform_admin', $3, 'contact.viewed')",
      [ws, p.id, grantId]);
    assert.ok(await admins() >= 2);
    await revoke(p);
    assert.equal(await isAdmin(p), 0);
    assert.equal(await audits("platform.admin_revoked", p), 1);
    const g = (await db.query<{ admin_user_id: string; ended: boolean }>(
      "select admin_user_id, revoked_at is not null ended from public.platform_access_grants where id = $1", [grantId])).rows[0];
    assert.deepEqual(g, { admin_user_id: p.id, ended: true });
    assert.equal(await adminCount(db, "select count(*) n from public.workspace_audit_log where grant_id = $1 and action = 'contact.viewed'", [grantId]), 1);
    assert.equal(await adminCount(db,
      "select count(*) n from public.workspace_audit_log where grant_id = $1 and action = 'platform.access_revoked' and actor_kind = 'system'", [grantId]), 1);
  });

  test("only the service role may call the operator functions (not anon, not a platform admin's own session)", async () => {
    const target = await user();
    const [current] = (await db.query<{ user_id: string }>("select user_id from public.platform_admins")).rows;
    const adminSession: TestUser = { id: current.user_id, email: "", aal: "aal2" };
    for (const who of [adminSession, target]) {
      await assert.rejects(asUser(db, who, (q) => rpc(q, "platform_admin_grant", [target.id, META])), /permission denied/);
      await assert.rejects(asUser(db, who, (q) => rpc(q, "platform_admin_revoke", [current.user_id, "Not allowed here", META])), /permission denied/);
    }
    const privileged = await db.query<{ proname: string; anon: boolean; auth: boolean; service: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth,
              has_function_privilege('service_role', p.oid, 'execute') service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('platform_admin_grant', 'platform_admin_revoke') order by 1`);
    assert.deepEqual(privileged.rows.map((r) => [r.proname, r.anon, r.auth, r.service]),
      [["platform_admin_grant", false, false, true], ["platform_admin_revoke", false, false, true]]);
    assert.equal(await isAdmin(target), 0);
  });
});

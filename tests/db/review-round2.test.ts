import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { adminCount, asAnon, asUser, buildWorld, rows, rpc, type Q, type World } from "./harness";

// Second security review. Finding 1 (authorization re-checked after the workspace lock) is proven
// under true concurrency in tests/db-real/concurrency.test.ts; here we pin the function structure.
// Finding 3 (audited platform-granted Storage mutations) and Storage policy isolation run against the
// shim's storage tables as role authenticated/anon with JWT claims, as the Storage API does.

const BUCKET = "workspace-assets";

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

async function fnDef(signature: string): Promise<string> {
  const r = await w.db.query<{ def: string }>("select pg_get_functiondef($1::regprocedure) def", [signature]);
  return r.rows[0].def.toLowerCase();
}

async function upload(q: Q, path: string): Promise<string> {
  const r = await rows<{ id: string }>(q,
    "insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, auth.uid()::text) returning id", [BUCKET, path]);
  return r[0].id;
}

async function visible(q: Q, path: string): Promise<number> {
  return (await rows<{ n: number }>(q, "select count(*)::int n from storage.objects where bucket_id = $1 and name = $2", [BUCKET, path]))[0].n;
}

async function storageAudit(ws: string, since: number) {
  const r = await w.db.query<{
    id: number; actor_id: string; actor_kind: string; grant_id: string | null; action: string; target: string;
    metadata: Record<string, string>;
  }>(
    `select id, actor_id, actor_kind, grant_id, action, target, metadata from public.workspace_audit_log
     where workspace_id = $1 and action like 'storage.%' and id > $2 order by id`, [ws, since]);
  return r.rows;
}

async function lastAuditId(): Promise<number> {
  return adminCount(w.db, "select coalesce(max(id), 0) n from public.workspace_audit_log");
}

describe("review 2, finding 1: membership RPCs re-check authority after the workspace lock", () => {
  const MEMBER_RPCS: [string, RegExp][] = [
    ["public.set_member_role(uuid, text)", /private\.recheck_authority\(v_ws, 'team\.change_role', true\)/],
    ["public.remove_member(uuid)", /private\.recheck_authority\(v_ws, null, true\)/],
    ["public.leave_workspace()", /private\.recheck_authority\(v_ws, null, true\)/],
    ["public.set_member_permission(uuid, text, boolean)", /private\.recheck_authority\(v_ws, 'team\.manage_overrides', true\)/],
    ["public.create_invitation(text, text, integer)", /private\.recheck_authority\(v_ws, private\.invitation_permission\(p_role\), false\)/],
    ["public.revoke_invitation(uuid)", /private\.recheck_authority\(v_ws, null, false\)/],
  ];

  for (const [sig, recheck] of MEMBER_RPCS) {
    test(`${sig}: the re-check immediately follows the lock and precedes every membership read and write`, async () => {
      const def = await fnDef(sig);
      const lock = def.indexOf("perform private.lock_workspace_membership(v_ws);");
      const m = recheck.exec(def);
      assert.ok(lock > 0, "lock missing");
      assert.ok(m, "re-check missing");
      const between = def.slice(lock + "perform private.lock_workspace_membership(v_ws);".length, m.index).trim();
      assert.equal(between, "perform", "nothing may run between the lock and the re-check");
      const firstUse = def.slice(m.index).search(
        /\bfrom public\.(workspace_members|workspace_invitations)\b|\b(insert into|update|delete from) public\.|private\.(assert_not_last_owner|deactivate_member)\(/);
      assert.ok(firstUse > 0, "membership access must come after the re-check");
      assert.equal(def.slice(0, lock).search(/\b(insert into|update|delete from) public\./), -1, "no write before the lock");
    });
  }

  test("bootstrap rotation re-checks platform admin status after the lock", async () => {
    const def = await fnDef("public.platform_rotate_bootstrap_invitation(uuid, text)");
    const lock = def.indexOf("perform private.lock_workspace_membership(p_workspace_id);");
    assert.ok(lock > 0);
    assert.ok(def.indexOf("perform private.require_platform_admin();", lock) > lock);
  });

  test("recheck_authority refuses a workspace that is no longer the caller's validated active workspace", async () => {
    const def = await fnDef("private.recheck_authority(uuid, text, boolean)");
    assert.match(def, /private\.active_workspace_id\(\) is distinct from p_workspace_id/);
    assert.match(def, /p_member_only and private\.active_member_role\(p_workspace_id\) is null/);
    assert.match(def, /not private\.has_permission\(p_permission\)/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query("select private.recheck_authority($1, null, true)", [w.wsA])),
      /permission denied for function/, "private helpers are not callable by clients");
  });
});

describe("Storage policies confine objects to the caller's active workspace (shim storage tables)", () => {
  const pathA = () => `${w.wsA}/policy-logo.png`;

  test("the private bucket, four policies, and the audit trigger exist", async () => {
    assert.equal(await adminCount(w.db, "select count(*) n from storage.buckets where id = $1 and public = false", [BUCKET]), 1);
    assert.equal(await adminCount(w.db,
      "select count(*) n from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'workspace_assets_%'"), 4);
    assert.equal(await adminCount(w.db,
      "select count(*) n from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'workspace_assets_audit_grant_write'"), 1);
  });

  test("an owner uploads into their workspace folder and reads it back", async () => {
    await asUser(w.db, w.ownerA, (q) => upload(q, pathA()));
    assert.equal(await asUser(w.db, w.ownerA, (q) => visible(q, pathA())), 1);
  });

  test("another workspace's owner can neither read nor write that folder", async () => {
    assert.equal(await asUser(w.db, w.ownerB, (q) => visible(q, pathA())), 0);
    await assert.rejects(asUser(w.db, w.ownerB, (q) => upload(q, `${w.wsA}/intruder.png`)), /row-level security/);
    const moved = await asUser(w.db, w.ownerB, (q) =>
      q.query("update storage.objects set name = $1 where bucket_id = $2 and name = $3", [`${w.wsB}/stolen.png`, BUCKET, pathA()]));
    assert.equal(moved.affectedRows, 0);
  });

  test("an employee can read but not write workspace assets", async () => {
    assert.equal(await asUser(w.db, w.employeeA, (q) => visible(q, pathA())), 1);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => upload(q, `${w.wsA}/employee.png`)), /row-level security/);
  });

  test("anonymous requests see nothing and cannot upload", async () => {
    assert.equal(await asAnon(w.db, (q) => visible(q, pathA())), 0);
    await assert.rejects(asAnon(w.db, (q) => q.query(
      "insert into storage.objects (bucket_id, name) values ($1, $2)", [BUCKET, `${w.wsA}/anon.png`])), /row-level security/);
  });

  test("an outsider and a path outside any workspace folder are refused", async () => {
    await assert.rejects(asUser(w.db, w.outsider, (q) => upload(q, `${w.wsA}/outsider.png`)), /row-level security/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => upload(q, "no-folder.png")), /row-level security/);
  });
});

describe("review 2, finding 3: platform-granted Storage mutations are audited", () => {
  test("member uploads are not recorded as platform actions", async () => {
    const since = await lastAuditId();
    await asUser(w.db, w.adminA, (q) => upload(q, `${w.wsA}/member-upload.png`));
    assert.deepEqual(await storageAudit(w.wsA, since), []);
  });

  test("insert, rename, and delete under a write grant record actor, workspace, grant, operation, and path", async () => {
    const grant = await asUser(w.db, w.platform, (q) =>
      rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "write", "storage audit regression", 15]));
    const since = await lastAuditId();
    const path = `${w.wsA}/granted.png`;
    const renamed = `${w.wsA}/granted-renamed.png`;

    await asUser(w.db, w.platform, (q) => upload(q, path));
    await asUser(w.db, w.platform, (q) =>
      q.query("update storage.objects set name = $1 where bucket_id = $2 and name = $3", [renamed, BUCKET, path]));
    await asUser(w.db, w.platform, (q) =>
      q.query("delete from storage.objects where bucket_id = $1 and name = $2", [BUCKET, renamed]));

    const audit = await storageAudit(w.wsA, since);
    assert.deepEqual(audit.map((a) => a.action), ["storage.object_insert", "storage.object_update", "storage.object_delete"]);
    for (const a of audit) {
      assert.equal(a.actor_id, w.platform.id);
      assert.equal(a.actor_kind, "platform_admin");
      assert.equal(a.grant_id, grant.id);
      assert.equal(a.metadata.bucket_id, BUCKET);
    }
    assert.deepEqual(audit.map((a) => a.metadata.operation), ["insert", "update", "delete"]);
    assert.deepEqual(audit.map((a) => a.target), [`${BUCKET}/${path}`, `${BUCKET}/${renamed}`, `${BUCKET}/${renamed}`]);
    assert.deepEqual(audit.map((a) => a.metadata.object_path), [path, renamed, renamed]);
    assert.equal(audit[1].metadata.previous_object_path, path);

    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id]));
  });

  test("a read grant can view assets but cannot mutate them, and nothing is audited", async () => {
    const grant = await asUser(w.db, w.platform, (q) =>
      rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "storage audit read regression", 15]));
    const since = await lastAuditId();
    assert.equal(await asUser(w.db, w.platform, (q) => visible(q, `${w.wsA}/policy-logo.png`)), 1);
    await assert.rejects(asUser(w.db, w.platform, (q) => upload(q, `${w.wsA}/read-grant.png`)), /row-level security/);
    assert.deepEqual(await storageAudit(w.wsA, since), []);
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id]));
  });

  test("after revocation the platform admin can no longer mutate assets", async () => {
    const since = await lastAuditId();
    await assert.rejects(asUser(w.db, w.platform, (q) => upload(q, `${w.wsA}/after-revoke.png`)), /row-level security/);
    assert.equal(await asUser(w.db, w.platform, (q) => visible(q, `${w.wsA}/policy-logo.png`)), 0);
    assert.deepEqual(await storageAudit(w.wsA, since), []);
  });

  test("the audit trigger function is not callable by clients", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query("select private.audit_grant_storage_write()")),
      /permission denied|trigger functions can only be called as triggers/);
  });
});

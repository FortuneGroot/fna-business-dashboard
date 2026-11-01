import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  accept, adminCount, asUser, buildWorld, createContact, createUser, invite, rows, rpc,
  type Q, type TestUser, type World,
} from "./harness";

// Coverage requested after the second review: Storage update/upsert, Storage access after membership
// and grant revocation, and per-member permission overrides. Runs against the shim's storage tables as
// role authenticated with JWT claims, as PostgREST and the Storage API do. Real-clock grant expiry and
// the concurrent provisioning/invitation races live in tests/db-real/concurrency.test.ts.

const BUCKET = "workspace-assets";

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

async function upload(q: Q, path: string): Promise<string> {
  const r = await rows<{ id: string }>(q,
    "insert into storage.objects (bucket_id, name, owner_id) values ($1, $2, auth.uid()::text) returning id", [BUCKET, path]);
  return r[0].id;
}

/** INSERT ... ON CONFLICT DO UPDATE, as the Storage API performs for an upload with x-upsert. */
async function upsert(q: Q, path: string, version: string): Promise<void> {
  await q.query(
    `insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, auth.uid()::text, $3)
     on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()`,
    [BUCKET, path, JSON.stringify({ version })]);
}

async function updateMeta(q: Q, path: string, version: string): Promise<number> {
  const r = await q.query("update storage.objects set metadata = $1, updated_at = now() where bucket_id = $2 and name = $3",
    [JSON.stringify({ version }), BUCKET, path]);
  return r.affectedRows ?? 0;
}

async function remove(q: Q, path: string): Promise<number> {
  const r = await q.query("delete from storage.objects where bucket_id = $1 and name = $2", [BUCKET, path]);
  return r.affectedRows ?? 0;
}

async function visible(q: Q, path: string): Promise<number> {
  return (await rows<{ n: number }>(q, "select count(*)::int n from storage.objects where bucket_id = $1 and name = $2", [BUCKET, path]))[0].n;
}

async function storedVersion(path: string): Promise<string | null> {
  const r = await w.db.query<{ v: string | null }>(
    "select metadata ->> 'version' v from storage.objects where bucket_id = $1 and name = $2", [BUCKET, path]);
  return r.rows[0]?.v ?? null;
}

async function lastAuditId(): Promise<number> {
  return adminCount(w.db, "select coalesce(max(id), 0) n from public.workspace_audit_log");
}

async function auditSince(ws: string, since: number, actionLike = "%") {
  const r = await w.db.query<{
    actor_id: string; actor_kind: string; grant_id: string | null; action: string; target: string; metadata: Record<string, string>;
  }>(
    `select actor_id, actor_kind, grant_id, action, target, metadata from public.workspace_audit_log
     where workspace_id = $1 and id > $2 and action like $3 order by id`, [ws, since, actionLike]);
  return r.rows;
}

async function grant(ws: string, mode: "read" | "write", reason: string): Promise<string> {
  return (await asUser(w.db, w.platform, (q) => rpc<{ id: string }>(q, "platform_grant_access", [ws, mode, reason, 15]))).id;
}

async function revoke(id: string): Promise<void> {
  await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [id, "Support session finished"]));
}

async function override(by: TestUser, target: TestUser, permission: string, allowed: boolean | null): Promise<void> {
  await asUser(w.db, by, (q) => rpc(q, "set_member_permission", [target.id, permission, allowed]));
}

async function permissions(user: TestUser): Promise<string[]> {
  return asUser(w.db, user, async (q) => (await rpc<{ permissions: string[] }>(q, "request_context")).permissions);
}

async function overrideRows(ws: string, user: TestUser): Promise<number> {
  return adminCount(w.db, "select count(*) n from public.member_permission_overrides where workspace_id = $1 and user_id = $2", [ws, user.id]);
}

async function newMember(owner: TestUser, email: string, role: string): Promise<TestUser> {
  const u = await createUser(w.db, email);
  await accept(w.db, u, await invite(w.db, owner, email, role));
  return u;
}

describe("Storage update and upsert require active membership plus settings.write", () => {
  const path = () => `${w.wsA}/upsert-logo.png`;

  test("an owner updates and upserts their own workspace object", async () => {
    await asUser(w.db, w.ownerA, (q) => upload(q, path()));
    assert.equal(await asUser(w.db, w.ownerA, (q) => updateMeta(q, path(), "v2")), 1);
    await asUser(w.db, w.ownerA, (q) => upsert(q, path(), "v3"));
    assert.equal(await storedVersion(path()), "v3");
    await asUser(w.db, w.ownerA, (q) => upsert(q, `${w.wsA}/upsert-new.png`, "n1"));
    assert.equal(await storedVersion(`${w.wsA}/upsert-new.png`), "n1");
  });

  test("member updates and upserts are not recorded as platform actions", async () => {
    const since = await lastAuditId();
    await asUser(w.db, w.adminA, (q) => upsert(q, path(), "v4"));
    await asUser(w.db, w.adminA, (q) => updateMeta(q, path(), "v5"));
    assert.deepEqual(await auditSince(w.wsA, since, "storage.%"), []);
  });

  test("an employee can neither update nor upsert workspace objects", async () => {
    assert.equal(await asUser(w.db, w.employeeA, (q) => updateMeta(q, path(), "employee")), 0);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => upsert(q, path(), "employee")), /row-level security/);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => upsert(q, `${w.wsA}/employee-new.png`, "employee")), /row-level security/);
    assert.equal(await storedVersion(path()), "v5");
  });

  test("another workspace's owner can neither update nor upsert over the object", async () => {
    assert.equal(await asUser(w.db, w.ownerB, (q) => updateMeta(q, path(), "intruder")), 0);
    await assert.rejects(asUser(w.db, w.ownerB, (q) => upsert(q, path(), "intruder")), /row-level security/);
    assert.equal(await storedVersion(path()), "v5");
  });

  test("a write grant alone can view but cannot update, upsert, insert, or delete", async () => {
    const g = await grant(w.wsA, "write", "storage upsert write-grant regression");
    const since = await lastAuditId();
    assert.equal(await asUser(w.db, w.platform, (q) => visible(q, path())), 1);
    assert.equal(await asUser(w.db, w.platform, (q) => updateMeta(q, path(), "g1")), 0);
    await assert.rejects(asUser(w.db, w.platform, (q) => upsert(q, path(), "g2")), /row-level security/);
    await assert.rejects(asUser(w.db, w.platform, (q) => upsert(q, `${w.wsA}/granted-upsert.png`, "g3")), /row-level security/);
    assert.equal(await asUser(w.db, w.platform, (q) => remove(q, path())), 0);
    assert.equal(await storedVersion(path()), "v5");
    assert.deepEqual(await auditSince(w.wsA, since, "storage.%"), []);
    await revoke(g);
  });

  test("a read grant can neither update nor upsert, and nothing is audited", async () => {
    const g = await grant(w.wsA, "read", "storage upsert read regression");
    const since = await lastAuditId();
    assert.equal(await asUser(w.db, w.platform, (q) => visible(q, path())), 1);
    assert.equal(await asUser(w.db, w.platform, (q) => updateMeta(q, path(), "read")), 0);
    await assert.rejects(asUser(w.db, w.platform, (q) => upsert(q, path(), "read")), /row-level security/);
    assert.deepEqual(await auditSince(w.wsA, since, "storage.%"), []);
    await revoke(g);
  });
});

describe("Storage access ends with the grant or membership that conferred it", () => {
  test("after a write grant is revoked: no read, update, upsert, delete, or audit", async () => {
    const path = `${w.wsA}/revocation.png`;
    await asUser(w.db, w.ownerA, (q) => upload(q, path));
    const g = await grant(w.wsA, "write", "storage revocation regression");
    assert.equal(await asUser(w.db, w.platform, (q) => visible(q, path)), 1);
    await revoke(g);
    const since = await lastAuditId();
    assert.equal(await asUser(w.db, w.platform, (q) => visible(q, path)), 0);
    assert.equal(await asUser(w.db, w.platform, (q) => updateMeta(q, path, "late")), 0);
    assert.equal(await asUser(w.db, w.platform, (q) => remove(q, path)), 0);
    await assert.rejects(asUser(w.db, w.platform, (q) => upsert(q, path, "late")), /row-level security/);
    await assert.rejects(asUser(w.db, w.platform, (q) => upload(q, `${w.wsA}/revocation-new.png`)), /row-level security/);
    assert.equal(await adminCount(w.db, "select count(*) n from storage.objects where name = $1", [path]), 1);
    assert.deepEqual(await auditSince(w.wsA, since, "storage.%"), []);
  });

  test("a removed admin loses Storage read and write immediately", async () => {
    const admin2 = await newMember(w.ownerA, "storage-admin2@example.test", "admin");
    const path = `${w.wsA}/admin2.png`;
    await asUser(w.db, admin2, (q) => upload(q, path));
    assert.equal(await asUser(w.db, admin2, (q) => visible(q, path)), 1);
    await asUser(w.db, w.ownerA, (q) => rpc(q, "remove_member", [admin2.id]));

    assert.equal(await asUser(w.db, admin2, (q) => visible(q, path)), 0);
    assert.equal(await asUser(w.db, admin2, (q) => updateMeta(q, path, "removed")), 0);
    assert.equal(await asUser(w.db, admin2, (q) => remove(q, path)), 0);
    await assert.rejects(asUser(w.db, admin2, (q) => upsert(q, path, "removed")), /row-level security/);
    await assert.rejects(asUser(w.db, admin2, (q) => upload(q, `${w.wsA}/admin2-after.png`)), /row-level security/);
    assert.equal(await adminCount(w.db, "select count(*) n from storage.objects where name = $1", [path]), 1);
  });

  test("a removed employee loses Storage read immediately", async () => {
    const emp2 = await newMember(w.ownerA, "storage-emp2@example.test", "employee");
    const path = `${w.wsA}/upsert-logo.png`;
    assert.equal(await asUser(w.db, emp2, (q) => visible(q, path)), 1);
    await asUser(w.db, w.ownerA, (q) => rpc(q, "remove_member", [emp2.id]));
    assert.equal(await asUser(w.db, emp2, (q) => visible(q, path)), 0);
  });

  test("suspension ends member Storage access; a read grant can still view; reactivation restores it", async () => {
    const path = `${w.wsB}/suspension.png`;
    await asUser(w.db, w.ownerB, (q) => upload(q, path));
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_suspend_workspace", [w.wsB, "storage suspension regression"]));
    try {
      assert.equal(await asUser(w.db, w.ownerB, (q) => visible(q, path)), 0);
      assert.equal(await asUser(w.db, w.ownerB, (q) => updateMeta(q, path, "suspended")), 0);
      await assert.rejects(asUser(w.db, w.ownerB, (q) => upsert(q, path, "suspended")), /row-level security/);
      const g = await grant(w.wsB, "read", "storage suspended read regression");
      assert.equal(await asUser(w.db, w.platform, (q) => visible(q, path)), 1);
      assert.equal(await asUser(w.db, w.platform, (q) => updateMeta(q, path, "suspended")), 0);
      await revoke(g);
    } finally {
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_reactivate_workspace", [w.wsB, "storage suspension regression"]));
    }
    assert.equal(await asUser(w.db, w.ownerB, (q) => visible(q, path)), 1);
  });
});

describe("per-member permission overrides", () => {
  test("an allow override lets an employee write workspace assets; clearing it removes that power", async () => {
    const path = `${w.wsA}/override-upload.png`;
    await assert.rejects(asUser(w.db, w.employeeA, (q) => upload(q, path)), /row-level security/);
    await override(w.ownerA, w.employeeA, "settings.write", true);
    assert.ok((await permissions(w.employeeA)).includes("settings.write"));
    await asUser(w.db, w.employeeA, (q) => upload(q, path));
    assert.equal(await asUser(w.db, w.employeeA, (q) => updateMeta(q, path, "e2")), 1);
    await asUser(w.db, w.employeeA, (q) => upsert(q, path, "e3"));
    assert.equal(await storedVersion(path), "e3");

    await override(w.ownerA, w.employeeA, "settings.write", null);
    assert.ok(!(await permissions(w.employeeA)).includes("settings.write"));
    assert.equal(await asUser(w.db, w.employeeA, (q) => updateMeta(q, path, "e4")), 0);
    assert.equal(await asUser(w.db, w.employeeA, (q) => remove(q, path)), 0);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => upload(q, `${w.wsA}/override-after.png`)), /row-level security/);
  });

  test("deny overrides remove a role's base permissions in RLS and RPCs", async () => {
    const contact = await createContact(w.db, w.ownerA, w.wsA, "Override contact");
    await override(w.adminA, w.employeeA, "contacts.write", false);
    await assert.rejects(
      asUser(w.db, w.employeeA, (q) => q.query("insert into public.contacts (workspace_id, first_name) values ($1, 'denied')", [w.wsA])),
      /row-level security/);
    const upd = await asUser(w.db, w.employeeA, (q) => q.query("update public.contacts set first_name = 'denied' where id = $1", [contact]));
    assert.equal(upd.affectedRows, 0);
    assert.ok(!(await permissions(w.employeeA)).includes("contacts.write"));

    await override(w.adminA, w.employeeA, "contacts.read", false);
    assert.equal(await asUser(w.db, w.employeeA, async (q) =>
      (await rows<{ n: number }>(q, "select count(*)::int n from public.contacts"))[0].n), 0);

    await override(w.adminA, w.employeeA, "contacts.write", null);
    await override(w.adminA, w.employeeA, "contacts.read", null);
    assert.ok(await asUser(w.db, w.employeeA, async (q) =>
      (await rows<{ n: number }>(q, "select count(*)::int n from public.contacts"))[0].n) > 0);
  });

  test("an allow override is honoured by RPC permission checks and ends when cleared", async () => {
    const contact = await createContact(w.db, w.ownerA, w.wsA, "Override delete");
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "soft_delete_contact", [contact])), /forbidden/);
    await override(w.ownerA, w.employeeA, "contacts.delete", true);
    await asUser(w.db, w.employeeA, (q) => rpc(q, "soft_delete_contact", [contact]));
    assert.equal(await adminCount(w.db, "select count(*) n from public.contacts where id = $1 and deleted_at is not null", [contact]), 1);
    await override(w.ownerA, w.employeeA, "contacts.delete", null);
    const another = await createContact(w.db, w.ownerA, w.wsA, "Override delete 2");
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "soft_delete_contact", [another])), /forbidden/);
  });

  test("overrides apply only in the workspace that set them", async () => {
    await asUser(w.db, w.dual, (q) => rpc(q, "switch_workspace", [w.wsA]));
    await override(w.ownerA, w.dual, "settings.write", true);
    await asUser(w.db, w.dual, (q) => upload(q, `${w.wsA}/dual-a.png`));
    await asUser(w.db, w.dual, (q) => rpc(q, "switch_workspace", [w.wsB]));
    assert.ok(!(await permissions(w.dual)).includes("settings.write"));
    await assert.rejects(asUser(w.db, w.dual, (q) => upload(q, `${w.wsB}/dual-b.png`)), /row-level security/);
    await asUser(w.db, w.dual, (q) => rpc(q, "switch_workspace", [w.wsA]));
    await override(w.ownerA, w.dual, "settings.write", null);
  });

  test("promotion clears overrides and demotion does not restore them", async () => {
    const emp = await newMember(w.ownerA, "override-promote@example.test", "employee");
    await override(w.ownerA, emp, "contacts.delete", true);
    await override(w.ownerA, emp, "contacts.write", false);
    assert.equal(await overrideRows(w.wsA, emp), 2);
    await asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_role", [emp.id, "admin"]));
    assert.equal(await overrideRows(w.wsA, emp), 0);
    await asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_role", [emp.id, "employee"]));
    assert.equal(await overrideRows(w.wsA, emp), 0);
    const perms = await permissions(emp);
    assert.ok(perms.includes("contacts.write") && !perms.includes("contacts.delete"), "back to base employee permissions");
  });

  test("removal clears overrides; a re-invited member starts with base permissions", async () => {
    const emp = await newMember(w.ownerA, "override-rejoin@example.test", "employee");
    await override(w.ownerA, emp, "settings.write", true);
    await asUser(w.db, w.ownerA, (q) => rpc(q, "remove_member", [emp.id]));
    assert.equal(await overrideRows(w.wsA, emp), 0);
    await accept(w.db, emp, await invite(w.db, w.ownerA, emp.email, "employee"));
    assert.ok(!(await permissions(emp)).includes("settings.write"));
    await assert.rejects(asUser(w.db, emp, (q) => upload(q, `${w.wsA}/rejoined.png`)), /row-level security/);
  });

  test("only members holding team.manage_overrides in the target's workspace can set overrides", async () => {
    await assert.rejects(override(w.employeeB, w.employeeB, "contacts.delete", true), /forbidden/);
    await assert.rejects(override(w.employeeA, w.dual, "contacts.delete", true), /forbidden/);
    await assert.rejects(override(w.ownerB, w.employeeA, "contacts.delete", true), /not_found/);
    const g = await grant(w.wsA, "write", "override platform regression");
    await assert.rejects(override(w.platform, w.employeeA, "contacts.delete", true), /forbidden/);
    await revoke(g);
    await assert.rejects(override(w.ownerA, w.employeeA, "not.a.permission", true), /validation_failed/);
    assert.equal(await overrideRows(w.wsA, w.employeeA), 0);
  });

  test("clients cannot write overrides directly, and other workspaces cannot read them", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(
      "insert into public.member_permission_overrides (workspace_id, user_id, permission, allowed) values ($1, $2, 'contacts.delete', true)",
      [w.wsA, w.employeeA.id])), /permission denied/);
    await override(w.ownerA, w.employeeA, "contacts.delete", true);
    assert.equal(await asUser(w.db, w.ownerB, async (q) =>
      (await rows<{ n: number }>(q, "select count(*)::int n from public.member_permission_overrides"))[0].n), 0);
    assert.equal(await asUser(w.db, w.ownerA, async (q) =>
      (await rows<{ n: number }>(q, "select count(*)::int n from public.member_permission_overrides where user_id = $1", [w.employeeA.id]))[0].n), 1);
    await override(w.ownerA, w.employeeA, "contacts.delete", null);
  });

  test("every override change is audited with the target and the exact permission", async () => {
    const since = await lastAuditId();
    await override(w.adminA, w.employeeA, "contacts.delete", true);
    await override(w.adminA, w.employeeA, "contacts.delete", null);
    const audit = await auditSince(w.wsA, since, "member.%");
    assert.deepEqual(audit.map((a) => [a.action, a.actor_id, a.actor_kind, a.target, a.metadata.permission, a.metadata.allowed]), [
      ["member.permission_override", w.adminA.id, "member", w.employeeA.id, "contacts.delete", true],
      ["member.permission_override", w.adminA.id, "member", w.employeeA.id, "contacts.delete", null],
    ]);
  });
});

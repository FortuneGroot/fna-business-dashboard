import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  accept, adminCount, asAnon, asUser, buildWorld, createUser, invite, makePlatformAdmin, rpc, type TestUser, type World,
} from "./harness";

// P2 RPCs (migration 20261101001500): the session's workspace list and the audit RPCs behind the
// platform Storage endpoint. Every call runs as role authenticated with the caller's JWT claims.

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

type Listed = { id: string; name: string; slug: string; status: string; role: string | null; grant_mode: string | null };
const list = (u: TestUser) => asUser(w.db, u, (q) => rpc<Listed[]>(q, "list_my_workspaces"));
const grant = (mode: "read" | "write", ws = w.wsA) =>
  asUser(w.db, w.platform, (q) => rpc<{ id: string }>(q, "platform_grant_access", [ws, mode, `p2 rpc test ${mode} grant`, 15]));
const revoke = (id: string) => asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [id]));
const requested = (u: TestUser, op: string, path: string) =>
  asUser(w.db, u, (q) => rpc<number>(q, "platform_storage_change_requested", [op, path]));
const finished = (u: TestUser, id: number, ok: boolean) =>
  asUser(w.db, u, (q) => rpc(q, "platform_storage_change_finished", [id, ok]));
const lastAuditId = () => adminCount(w.db, "select coalesce(max(id), 0) n from public.workspace_audit_log");
const auditSince = async (since: number) =>
  (await w.db.query<{ id: number; workspace_id: string; actor_id: string; actor_kind: string; grant_id: string | null;
    action: string; target: string; metadata: Record<string, string> }>(
    `select id, workspace_id, actor_id, actor_kind, grant_id, action, target, metadata
     from public.workspace_audit_log where id > $1 order by id`, [since])).rows;

describe("P2: list_my_workspaces", () => {
  test("a member of two workspaces sees both with their roles, sorted by name", async () => {
    const items = await list(w.dual);
    assert.deepEqual(items.map((i) => [i.id, i.role, i.grant_mode, i.status]), [
      [w.wsA, "employee", null, "active"],
      [w.wsB, "employee", null, "active"],
    ]);
    assert.deepEqual(Object.keys(items[0]).sort(), ["grant_mode", "id", "name", "role", "slug", "status"]);
  });

  test("an outsider sees nothing; anonymous callers cannot execute it", async () => {
    assert.deepEqual(await list(w.outsider), []);
    await assert.rejects(asAnon(w.db, (q) => rpc(q, "list_my_workspaces")), /permission denied/);
  });

  test("a suspended workspace stays listed with its status so the app can explain it", async () => {
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_suspend_workspace", [w.wsB, "p2 list suspension test"]));
    try {
      const b = (await list(w.ownerB)).find((i) => i.id === w.wsB);
      assert.equal(b?.status, "suspended");
      assert.equal(b?.role, "owner");
    } finally {
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_reactivate_workspace", [w.wsB, "p2 list reactivation test"]));
    }
  });

  test("platform admins see only workspaces reachable through their own live grants, and only at AAL2", async () => {
    assert.deepEqual(await list(w.platform), []);
    const g = await grant("read");
    try {
      assert.deepEqual((await list(w.platform)).map((i) => [i.id, i.role, i.grant_mode]), [[w.wsA, null, "read"]]);
      assert.deepEqual(await list({ ...w.platform, aal: "aal1" }), [], "an AAL1 session is not a platform admin");
    } finally {
      await revoke(g.id);
    }
    assert.deepEqual(await list(w.platform), []);
  });
});

describe("P2: audited platform Storage change RPCs", () => {
  const logo = () => `${w.wsA}/logo.png`;

  test("refused for members, for platform admins without a write grant, and for read grants", async () => {
    await assert.rejects(requested(w.ownerA, "upsert", logo()), /forbidden/, "members use Storage directly");
    await assert.rejects(requested(w.platform, "upsert", logo()), /forbidden/, "no grant");
    const g = await grant("read");
    try {
      await assert.rejects(requested(w.platform, "upsert", logo()), /forbidden/, "read grant");
    } finally {
      await revoke(g.id);
    }
  });

  test("a platform admin who is also a member must use the member path", async () => {
    const both = await createUser(w.db, "platform-member@example.test", "aal2");
    await makePlatformAdmin(w.db, both);
    await accept(w.db, both, await invite(w.db, w.ownerA, both.email, "employee"));
    const g = await asUser(w.db, both, (q) => rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "write", "p2 member and platform", 15]));
    try {
      await assert.rejects(requested(both, "upsert", logo()), /forbidden/);
    } finally {
      await asUser(w.db, both, (q) => rpc(q, "platform_revoke_access", [g.id]));
    }
  });

  test("under a write grant: only this workspace's logo path and known operations are accepted", async () => {
    const g = await grant("write");
    const since = await lastAuditId();
    try {
      for (const [op, path] of [
        ["insert", logo()],
        ["upsert", `${w.wsB}/logo.png`],
        ["upsert", `${w.wsA}/other.png`],
        ["upsert", `${w.wsA}/logo.svg`],
        ["upsert", `${w.wsA}/nested/logo.png`],
        ["delete", `../${w.wsA}/logo.png`],
      ]) {
        await assert.rejects(requested(w.platform, op, path), /validation_failed/, `${op} ${path}`);
      }
      await assert.rejects(requested({ ...w.platform, aal: "aal1" }, "upsert", logo()), /forbidden/, "AAL1");
      assert.deepEqual(await auditSince(since), [], "refused requests write nothing");
    } finally {
      await revoke(g.id);
    }
  });

  test("a request and its outcome are audited with actor, grant, operation, and object path", async () => {
    const g = await grant("write");
    const since = await lastAuditId();
    let id: number;
    try {
      id = Number(await requested(w.platform, "upsert", logo()));
      await finished(w.platform, id, true);
      const del = Number(await requested(w.platform, "delete", logo()));
      await finished(w.platform, del, false);
    } finally {
      await revoke(g.id);
    }
    const rows = (await auditSince(since)).filter((r) => r.action.startsWith("storage."));
    const base = { operation: "upsert", bucket_id: "workspace-assets", object_path: logo(), via: "platform_endpoint" };
    assert.deepEqual(rows.map((r) => ({ ws: r.workspace_id, actor: r.actor_id, kind: r.actor_kind, grant: r.grant_id,
      action: r.action, target: r.target, metadata: r.metadata })), [
      { ws: w.wsA, actor: w.platform.id, kind: "platform_admin", grant: g.id, action: "storage.object_upsert",
        target: `workspace-assets/${logo()}`, metadata: { ...base, outcome: "requested" } },
      { ws: w.wsA, actor: w.platform.id, kind: "platform_admin", grant: g.id, action: "storage.object_upsert",
        target: `workspace-assets/${logo()}`, metadata: { ...base, outcome: "succeeded", request_id: String(id!) } },
      { ws: w.wsA, actor: w.platform.id, kind: "platform_admin", grant: g.id, action: "storage.object_delete",
        target: `workspace-assets/${logo()}`, metadata: { ...base, operation: "delete", outcome: "requested" } },
      { ws: w.wsA, actor: w.platform.id, kind: "platform_admin", grant: g.id, action: "storage.object_delete",
        target: `workspace-assets/${logo()}`, metadata: { ...base, operation: "delete", outcome: "failed", request_id: String(rows[2]?.id) } },
    ]);
  });

  test("each request gets exactly one outcome, only from its own requester; the outcome survives revocation", async () => {
    const g = await grant("write");
    const id = Number(await requested(w.platform, "upsert", logo()));
    await revoke(g.id);
    await assert.rejects(finished(w.ownerA, id, true), /forbidden/, "a non-platform user cannot record outcomes");
    const other = await createUser(w.db, "platform-other@example.test", "aal2");
    await makePlatformAdmin(w.db, other);
    await assert.rejects(finished(other, id, true), /not_found/, "another platform admin cannot record this outcome");
    await finished(w.platform, id, true);
    await assert.rejects(finished(w.platform, id, true), /conflict/, "a second outcome is refused");
    await assert.rejects(finished(w.platform, 987654321, true), /not_found/);
    const outcomes = await adminCount(w.db,
      "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)]);
    assert.equal(outcomes, 1);
  });

  test("audit rows written by these RPCs are append-only for clients", async () => {
    await assert.rejects(asUser(w.db, w.platform, (q) =>
      q.query("delete from public.workspace_audit_log where action like 'storage.%'")), /permission denied/);
  });
});

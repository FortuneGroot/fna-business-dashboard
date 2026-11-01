import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  accept, adminCount, asAnon, asServiceRole, asUser, buildWorld, createUser, invite, makePlatformAdmin, rpc,
  type TestUser, type World,
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
const claim = (id: number, actor: TestUser) =>
  asServiceRole(w.db, (q) => rpc(q, "platform_storage_change_claimed", [id, actor.id]));
/** What the server does: request (user JWT), claim (service role); returns the request id. */
const start = async (op: string, path: string) => {
  const id = Number(await requested(w.platform, op, path));
  await claim(id, w.platform);
  return id;
};
const finished = (id: number, actor: TestUser) =>
  asServiceRole(w.db, (q) => rpc<string>(q, "platform_storage_change_finished", [id, actor.id]));
const putObject = (path: string) =>
  asServiceRole(w.db, (q) => q.query(
    `insert into storage.objects (bucket_id, name) values ('workspace-assets', $1)
     on conflict (bucket_id, name) do update set updated_at = clock_timestamp()`, [path]));
const removeObject = (path: string) =>
  asServiceRole(w.db, (q) => q.query("delete from storage.objects where bucket_id = 'workspace-assets' and name = $1", [path]));
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

  test("outcomes are derived from Storage: request, write, and outcome audited with actor, grant, operation, path", async () => {
    const g = await grant("write");
    const since = await lastAuditId();
    const ids: number[] = [];
    try {
      ids.push(await start("upsert", logo()));
      await putObject(logo());
      assert.equal(await finished(ids[0], w.platform), "succeeded", "object created after the request");
      ids.push(await start("upsert", logo()));
      await putObject(logo());
      assert.equal(await finished(ids[1], w.platform), "succeeded", "existing object replaced after the request");
      ids.push(await start("upsert", logo()));
      assert.equal(await finished(ids[2], w.platform), "failed", "no Storage change → failed, whatever the caller claims");
      ids.push(await start("delete", logo()));
      await removeObject(logo());
      assert.equal(await finished(ids[3], w.platform), "succeeded", "object removed after the request");
      ids.push(await start("delete", logo()));
      assert.equal(await finished(ids[4], w.platform), "failed", "deleting an absent object is not a success");
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
    const rows = (await auditSince(since)).filter((r) => r.action.startsWith("storage."));
    const base = { bucket_id: "workspace-assets", object_path: logo(), via: "platform_endpoint" };
    const expected = (op: string, outcome: string, i: number) => [
      { ws: w.wsA, actor: w.platform.id, kind: "platform_admin", grant: g.id, action: `storage.object_${op}`,
        target: `workspace-assets/${logo()}`, metadata: { ...base, operation: op, outcome: "requested" } },
      { ws: w.wsA, actor: w.platform.id, kind: "platform_admin", grant: g.id, action: `storage.object_${op}`,
        target: `workspace-assets/${logo()}`,
        metadata: { ...base, operation: op, outcome, request_id: String(ids[i]), recorded_by: "server" } },
    ];
    assert.deepEqual(rows.map((r) => ({ ws: r.workspace_id, actor: r.actor_id, kind: r.actor_kind, grant: r.grant_id,
      action: r.action, target: r.target, metadata: { ...r.metadata, object_before: undefined } })).map((r) =>
      JSON.parse(JSON.stringify(r))), [
      ...expected("upsert", "succeeded", 0), ...expected("upsert", "succeeded", 1), ...expected("upsert", "failed", 2),
      ...expected("delete", "succeeded", 3), ...expected("delete", "failed", 4),
    ]);
    assert.equal((rows[0].metadata as Record<string, unknown>).object_before, null, "request rows snapshot the prior state");
    assert.equal(typeof (rows[2].metadata as Record<string, unknown>).object_before, "object");
  });

  test("outcomes are server-only: platform admins, members, and anon cannot record or fabricate them", async () => {
    const g = await grant("write");
    const since = await lastAuditId();
    let id: number;
    try {
      id = Number(await requested(w.platform, "upsert", logo()));
    } finally {
      await revoke(g.id);
    }
    for (const fn of ["platform_storage_change_claimed", "platform_storage_change_finished"]) {
      for (const [who, call] of [
        ["the requesting platform admin", () => asUser(w.db, w.platform, (q) => rpc(q, fn, [id, w.platform.id]))],
        ["a member", () => asUser(w.db, w.ownerA, (q) => rpc(q, fn, [id, w.platform.id]))],
        ["anon", () => asAnon(w.db, (q) => rpc(q, fn, [id, w.platform.id]))],
      ] as const) {
        await assert.rejects(call(), /permission denied/, `${fn}: ${who}`);
      }
    }
    await assert.rejects(finished(id, w.platform), /not_found/, "an unclaimed request (no server write) never gets an outcome");
    await assert.rejects(asUser(w.db, w.platform, (q) => q.query("select public.platform_storage_change_finished($1, true)", [id])),
      /does not exist/, "the client-controlled (bigint, boolean) signature is gone");
    await assert.rejects(asUser(w.db, w.platform, (q) => q.query(
      `insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, action, metadata)
       values ($1, $2, 'platform_admin', 'storage.object_upsert', '{"outcome":"succeeded"}')`, [w.wsA, w.platform.id])),
      /permission denied/, "clients cannot insert audit rows directly");
    assert.deepEqual((await auditSince(since)).filter((r) => r.metadata.outcome !== "requested" && r.action.startsWith("storage.")), []);
  });

  test("completion is idempotent, bound to the requester, needs no live grant, and stays recoverable", async () => {
    const g = await grant("write");
    const id = await start("upsert", logo());
    const other = await createUser(w.db, "platform-other@example.test", "aal2");
    await makePlatformAdmin(w.db, other);
    try {
      // One open change per object: a second claim waits until the first is recovered.
      const second = Number(await requested(w.platform, "upsert", logo()));
      await assert.rejects(claim(second, w.platform), /conflict/, "another change to the same object is pending");
      await assert.rejects(claim(id, w.platform), /conflict/, "a request is claimed once");
      await assert.rejects(claim(id, other), /not_found/, "only for the requester");
      await putObject(logo());
      await revoke(g.id);
      await assert.rejects(finished(id, other), /not_found/, "another admin's id cannot complete this request");
      await assert.rejects(finished(987654321, w.platform), /not_found/);
      await assert.rejects(asServiceRole(w.db, (q) => rpc(q, "platform_storage_change_finished", [null, w.platform.id])), /validation_failed/);
      // A pending request has no outcome until the server records one; it is not lost.
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)]), 0);
      assert.equal(await finished(id, w.platform), "succeeded", "recovered after revocation");
      await removeObject(logo());
      assert.equal(await finished(id, w.platform), "succeeded", "a retry returns the recorded outcome, not a new one");
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)]), 1);
    } finally {
      await removeObject(logo());
    }
  });

  test("a direct requested call is never completed, even if the object changes for another reason", async () => {
    const g = await grant("write");
    try {
      const spoof = Number(await requested(w.platform, "upsert", logo()));
      const real = await start("upsert", logo());
      await putObject(logo());
      assert.equal(await finished(real, w.platform), "succeeded");
      await assert.rejects(finished(spoof, w.platform), /not_found/);
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(spoof)]), 0);
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
  });

  test("audit rows written by these RPCs are append-only for clients", async () => {
    await assert.rejects(asUser(w.db, w.platform, (q) =>
      q.query("delete from public.workspace_audit_log where action like 'storage.%'")), /permission denied/);
  });
});

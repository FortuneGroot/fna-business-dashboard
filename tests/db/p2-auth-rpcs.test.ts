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
const revoke = (id: string) => asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [id, "Support session finished"]));
const requested = (u: TestUser, op: string, path: string) =>
  asUser(w.db, u, (q) => rpc<number>(q, "platform_storage_change_requested", [op, path]));
const claim = (id: number, actor: TestUser) =>
  asServiceRole(w.db, (q) => rpc<string>(q, "platform_storage_change_claimed", [id, actor.id]));
/** What the server does: request (user JWT), claim (service role); returns the request id and token. */
const start = async (op: string, path: string) => {
  const id = Number(await requested(w.platform, op, path));
  return { id, token: await claim(id, w.platform) };
};
const finished = (id: number, actor: TestUser, operationReturned = true) =>
  asServiceRole(w.db, (q) => rpc<string>(q, "platform_storage_change_finished", [id, actor.id, operationReturned]));
const expireLease = (id: number) =>
  w.db.query("update private.platform_storage_changes set claimed_at = claimed_at - interval '3 minutes' where request_id = $1", [id]);
/** A Storage upsert as the Storage API commits it (new version), as the service role. */
const serviceUpsert = (path: string, metadata: Record<string, unknown> | null) =>
  asServiceRole(w.db, (q) => q.query(
    `insert into storage.objects (bucket_id, name, user_metadata, version)
     values ('workspace-assets', $1, $2, gen_random_uuid()::text)
     on conflict (bucket_id, name) do update
       set user_metadata = excluded.user_metadata, version = excluded.version, updated_at = clock_timestamp()`,
    [path, metadata]));
/** The server's own upsert for an operation: tagged with its token. */
const serverUpsert = (path: string, token: string) => serviceUpsert(path, { platform_operation: token });
const tombstone = (path: string, id: number, token: string) =>
  `${path.split("/")[0]}/.platform-trash/${id}-${token}.${path.split(".").pop()}`;
/** The server's own delete for an operation: a move to its tombstone (Storage move = one row update), then cleanup. */
const serverDelete = (path: string, id: number, token: string) =>
  asServiceRole(w.db, async (q) => {
    const moved = await q.query("update storage.objects set name = $2 where bucket_id = 'workspace-assets' and name = $1",
      [path, tombstone(path, id, token)]);
    await q.query("delete from storage.objects where bucket_id = 'workspace-assets' and name = $1", [tombstone(path, id, token)]);
    return moved.affectedRows ?? 0;
  });
/** A member's own Storage write under the members-only policies (ownerA holds settings.write). */
const memberUpsert = (path: string, metadata: Record<string, unknown> | null = null) =>
  asUser(w.db, w.ownerA, (q) => q.query(
    `insert into storage.objects (bucket_id, name, owner_id, user_metadata, version)
     values ('workspace-assets', $1, auth.uid()::text, $2, gen_random_uuid()::text)
     on conflict (bucket_id, name) do update
       set user_metadata = excluded.user_metadata, version = excluded.version, updated_at = clock_timestamp()`,
    [path, metadata]));
const memberDelete = (path: string) =>
  asUser(w.db, w.ownerA, (q) => q.query("delete from storage.objects where bucket_id = 'workspace-assets' and name = $1", [path]));
const removeObject = (path: string) =>
  asServiceRole(w.db, (q) => q.query("delete from storage.objects where bucket_id = 'workspace-assets' and name = $1", [path]));
const objectRow = async (path: string) =>
  (await w.db.query<{ owner_id: string | null; user_metadata: Record<string, unknown> | null }>(
    "select owner_id, user_metadata from storage.objects where bucket_id = 'workspace-assets' and name = $1", [path])).rows[0] ?? null;
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
      await asUser(w.db, both, (q) => rpc(q, "platform_revoke_access", [g.id, "Support session finished"]));
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

  test("outcomes come from the server's own tagged operation: request and outcome audited with actor, grant, operation, path", async () => {
    const g = await grant("write");
    const since = await lastAuditId();
    const ids: number[] = [];
    try {
      let op = await start("upsert", logo());
      ids.push(op.id);
      await serverUpsert(logo(), op.token);
      assert.equal(await finished(op.id, w.platform), "succeeded", "object created by this operation");
      op = await start("upsert", logo());
      ids.push(op.id);
      await serverUpsert(logo(), op.token);
      assert.equal(await finished(op.id, w.platform), "succeeded", "existing object replaced by this operation");
      op = await start("upsert", logo());
      ids.push(op.id);
      assert.equal(await finished(op.id, w.platform), "failed", "no write by this operation → failed");
      op = await start("delete", logo());
      ids.push(op.id);
      assert.equal(await serverDelete(logo(), op.id, op.token), 1);
      assert.equal(await finished(op.id, w.platform), "succeeded", "object removed by this operation");
      op = await start("delete", logo());
      ids.push(op.id);
      assert.equal(await serverDelete(logo(), op.id, op.token), 0);
      assert.equal(await finished(op.id, w.platform), "failed", "deleting an absent object is not a success");
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
        metadata: { ...base, operation: op, outcome, request_id: String(ids[i]), recorded_by: "server", resolved_by: "operation" } },
    ];
    assert.deepEqual(rows.map((r) => ({ ws: r.workspace_id, actor: r.actor_id, kind: r.actor_kind, grant: r.grant_id,
      action: r.action, target: r.target, metadata: r.metadata })), [
      ...expected("upsert", "succeeded", 0), ...expected("upsert", "succeeded", 1), ...expected("upsert", "failed", 2),
      ...expected("delete", "succeeded", 3), ...expected("delete", "failed", 4),
    ]);
    for (const r of rows) assert.equal(JSON.stringify(r.metadata).includes("token"), false, "the token is never audited or exposed");
  });

  test("outcomes are server-only: platform admins, members, and anon cannot claim, record, or fabricate them", async () => {
    const g = await grant("write");
    const since = await lastAuditId();
    let id: number;
    try {
      id = Number(await requested(w.platform, "upsert", logo()));
    } finally {
      await revoke(g.id);
    }
    for (const [fn, args] of [
      ["platform_storage_change_claimed", [id, w.platform.id]],
      ["platform_storage_change_finished", [id, w.platform.id, true]],
    ] as const) {
      for (const [who, call] of [
        ["the requesting platform admin", () => asUser(w.db, w.platform, (q) => rpc(q, fn, [...args]))],
        ["a member", () => asUser(w.db, w.ownerA, (q) => rpc(q, fn, [...args]))],
        ["anon", () => asAnon(w.db, (q) => rpc(q, fn, [...args]))],
      ] as const) {
        await assert.rejects(call(), /permission denied/, `${fn}: ${who}`);
      }
    }
    await assert.rejects(finished(id, w.platform), /not_found/, "an unclaimed request (no server write) never gets an outcome");
    for (const sig of ["$1, true", "$1, $2::uuid"]) {
      await assert.rejects(asServiceRole(w.db, (q) => q.query(`select public.platform_storage_change_finished(${sig})`,
        sig.includes("$2") ? [id, w.platform.id] : [id])), /does not exist/, `old signature (${sig}) is gone`);
    }
    await assert.rejects(asUser(w.db, w.platform, (q) => q.query(
      `insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, action, metadata)
       values ($1, $2, 'platform_admin', 'storage.object_upsert', '{"outcome":"succeeded"}')`, [w.wsA, w.platform.id])),
      /permission denied/, "clients cannot insert audit rows directly");
    await assert.rejects(asUser(w.db, w.platform, (q) => q.query("select token from private.platform_storage_changes")),
      /permission denied/, "operation tokens are not readable by clients");
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query("select token from private.platform_storage_changes")),
      /permission denied/);
    assert.deepEqual((await auditSince(since)).filter((r) => r.metadata.outcome !== "requested" && r.action.startsWith("storage.")), []);
  });

  test("completion is idempotent, bound to the requester, needs no live grant, and stays recoverable", async () => {
    const g = await grant("write");
    const { id, token } = await start("upsert", logo());
    const other = await createUser(w.db, "platform-other@example.test", "aal2");
    await makePlatformAdmin(w.db, other);
    try {
      // One open change per object: a second claim waits until the first is recovered.
      const second = Number(await requested(w.platform, "upsert", logo()));
      await assert.rejects(claim(second, w.platform), /conflict/, "another change to the same object is pending");
      await assert.rejects(claim(id, w.platform), /conflict/, "a request is claimed once");
      await assert.rejects(claim(id, other), /not_found/, "only for the requester");
      await serverUpsert(logo(), token);
      await revoke(g.id);
      await assert.rejects(finished(id, other), /not_found/, "another admin's id cannot complete this request");
      await assert.rejects(finished(987654321, w.platform), /not_found/);
      await assert.rejects(asServiceRole(w.db, (q) => rpc(q, "platform_storage_change_finished", [null, w.platform.id, true])), /validation_failed/);
      await assert.rejects(asServiceRole(w.db, (q) => rpc(q, "platform_storage_change_finished", [id, w.platform.id, null])), /validation_failed/);
      // A pending request has no outcome until the server records one; it is not lost.
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)]), 0);
      assert.equal(await finished(id, w.platform, false), "succeeded", "recovered after revocation: the write was applied");
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
      await serverUpsert(logo(), real.token);
      assert.equal(await finished(real.id, w.platform), "succeeded");
      await assert.rejects(finished(spoof, w.platform), /not_found/);
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(spoof)]), 0);
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
  });

  test("recovery while the operation may still be running records nothing and keeps the claim", async () => {
    const g = await grant("write");
    try {
      const { id, token } = await start("upsert", logo());
      assert.equal(await finished(id, w.platform, false), "pending", "no response, not applied, lease open");
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)]), 0);
      assert.equal(await adminCount(w.db,
        "select count(*) n from private.platform_storage_changes where request_id = $1 and finished_at is null", [id]), 1);
      const next = Number(await requested(w.platform, "upsert", logo()));
      await assert.rejects(claim(next, w.platform), /conflict/, "the claim is not released");

      await serverUpsert(logo(), token);
      assert.equal(await finished(id, w.platform, false), "succeeded", "once its own write committed, the outcome is established");
      const meta = (await auditSince(id)).find((r) => r.metadata.request_id === String(id))!.metadata;
      assert.equal(meta.resolved_by, "recovery");
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
  });

  test("after the lease, recording 'failed' closes the operation: its late write is refused and never takes effect", async () => {
    const g = await grant("write");
    try {
      const { id, token } = await start("upsert", logo());
      await expireLease(id);
      assert.equal(await finished(id, w.platform, false), "failed");
      await assert.rejects(serverUpsert(logo(), token), /platform_operation_closed/, "late upsert refused");
      assert.equal(await objectRow(logo()), null, "the refused write left nothing");

      // A later operation on the same object is unaffected by the stale one.
      const next = await start("upsert", logo());
      await assert.rejects(serverUpsert(logo(), token), /platform_operation_closed/);
      await serverUpsert(logo(), next.token);
      assert.equal(await finished(next.id, w.platform), "succeeded");

      const del = await start("delete", logo());
      await expireLease(del.id);
      assert.equal(await finished(del.id, w.platform, false), "failed");
      await assert.rejects(serverDelete(logo(), del.id, del.token), /platform_operation_closed/, "late delete (move) refused");
      assert.notEqual(await objectRow(logo()), null, "the logo is still there");
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
  });

  test("a member's write to the same object during a pending platform upsert is not a platform success", async () => {
    const g = await grant("write");
    try {
      const { id } = await start("upsert", logo());
      await memberUpsert(logo());
      assert.equal((await objectRow(logo()))?.owner_id, w.ownerA.id, "the member's write is stored (members-only policies allow it)");
      assert.equal(await finished(id, w.platform, false), "pending", "a member write is not this operation's write");
      await expireLease(id);
      assert.equal(await finished(id, w.platform, false), "failed");

      const second = await start("upsert", logo());
      await memberUpsert(logo());
      assert.equal(await finished(second.id, w.platform), "failed", "object changed, but not by this operation");

      // The Storage API commits every upload as service_role and may keep existing metadata: an upload
      // that carries a previous operation's token over unchanged is neither attributed nor refused.
      const done = await start("upsert", logo());
      await serverUpsert(logo(), done.token);
      assert.equal(await finished(done.id, w.platform), "succeeded");
      const third = await start("upsert", logo());
      await serviceUpsert(logo(), { platform_operation: done.token });
      assert.equal(await finished(third.id, w.platform, false), "pending", "a carried-over token is not a new write");
      await expireLease(third.id);
      assert.equal(await finished(third.id, w.platform, false), "failed");
      await assert.rejects(serviceUpsert(`${w.wsA}/logo.webp`, { platform_operation: done.token }), /platform_operation_closed/,
        "a finished operation's token newly written anywhere is refused");
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
  });

  test("a member's delete of the same object during a pending platform delete is not a platform success", async () => {
    const g = await grant("write");
    try {
      await memberUpsert(logo());
      const { id, token } = await start("delete", logo());
      await memberDelete(logo());
      assert.equal(await objectRow(logo()), null);
      assert.equal(await serverDelete(logo(), id, token), 0, "the server's move finds nothing to move");
      assert.equal(await finished(id, w.platform), "failed");
    } finally {
      await revoke(g.id);
      await removeObject(logo());
    }
  });

  test("service-role writes are attributed only with a matching token, path, and operation", async () => {
    const g = await grant("write");
    try {
      const { id, token } = await start("upsert", logo());
      await serviceUpsert(logo(), null);
      await serviceUpsert(logo(), { platform_operation: "not-a-token" });
      await serviceUpsert(logo(), { platform_operation: "00000000-0000-4000-8000-000000000000" });
      await assert.rejects(serverUpsert(`${w.wsA}/logo.jpg`, token), /platform_operation_mismatch/, "another path");
      await assert.rejects(serverDelete(logo(), id, token), /platform_operation_mismatch/, "a move for an upsert operation");
      await expireLease(id);
      assert.equal(await finished(id, w.platform, false), "failed", "untagged or foreign-tagged writes do not count");
    } finally {
      await revoke(g.id);
      await removeObject(logo());
      await removeObject(`${w.wsA}/logo.jpg`);
    }
  });

  test("audit rows written by these RPCs are append-only for clients", async () => {
    await assert.rejects(asUser(w.db, w.platform, (q) =>
      q.query("delete from public.workspace_audit_log where action like 'storage.%'")), /permission denied/);
  });
});

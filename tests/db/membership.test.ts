import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  adminCount, asUser, buildWorld, createContact, createUser, rows, rpc, stageId,
  type TestUser, type World,
} from "./harness";

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

async function invite(inviter: TestUser, email: string, role: string): Promise<string> {
  return (await asUser(w.db, inviter, (q) => rpc<{ token: string }>(q, "create_invitation", [email, role, 72]))).token;
}

async function memberRole(ws: string, user: TestUser): Promise<string | null> {
  const r = await w.db.query<{ role: string; status: string }>(
    "select role, status from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, user.id]);
  const row = r.rows[0];
  return row && row.status === "active" ? row.role : null;
}

describe("role escalation and unauthorized membership changes are denied", () => {
  test("an employee cannot change roles, remove members, or invite anyone", async () => {
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "set_member_role", [w.employeeA.id, "owner"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "set_member_role", [w.adminA.id, "employee"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "remove_member", [w.dual.id])), /forbidden/);
    for (const role of ["employee", "admin", "owner"]) {
      await assert.rejects(
        asUser(w.db, w.employeeA, (q) => rpc(q, "create_invitation", [`new-${role}@example.test`, role, 72])),
        /forbidden/);
    }
    assert.equal(await memberRole(w.wsA, w.employeeA), "employee");
    assert.equal(await memberRole(w.wsA, w.adminA), "admin");
  });

  test("an admin cannot promote to admin/owner, demote or remove owners/admins, or invite admins/owners", async () => {
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "set_member_role", [w.employeeA.id, "admin"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "set_member_role", [w.employeeA.id, "owner"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "set_member_role", [w.ownerA.id, "employee"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "remove_member", [w.ownerA.id])), /forbidden/);
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "create_invitation", ["x-admin@example.test", "admin", 72])), /forbidden/);
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "create_invitation", ["x-owner@example.test", "owner", 72])), /forbidden/);
    assert.equal(await memberRole(w.wsA, w.employeeA), "employee");
    assert.equal(await memberRole(w.wsA, w.ownerA), "owner");
  });

  test("an admin can invite employees and manage employee overrides, but overrides cannot grant team or credential powers", async () => {
    const token = await invite(w.adminA, "admin-invited@example.test", "employee");
    assert.match(token, /^[0-9a-f]{64}$/);
    await asUser(w.db, w.adminA, (q) => rpc(q, "set_member_permission", [w.employeeA.id, "contacts.delete", true]));
    await asUser(w.db, w.employeeA, async (q) => {
      const ctx = await rpc<{ permissions: string[] }>(q, "request_context");
      assert.ok(ctx.permissions.includes("contacts.delete"));
    });
    for (const p of ["team.invite_employee", "team.change_role", "integrations.manage", "onboarding.read"]) {
      await assert.rejects(
        asUser(w.db, w.adminA, (q) => rpc(q, "set_member_permission", [w.employeeA.id, p, true])),
        /check constraint|violates/, p);
    }
    await assert.rejects(
      asUser(w.db, w.adminA, (q) => rpc(q, "set_member_permission", [w.ownerA.id, "contacts.read", false])),
      /employees only/);
    await asUser(w.db, w.adminA, (q) => rpc(q, "set_member_permission", [w.employeeA.id, "contacts.delete", null]));
  });

  test("nobody can change or remove their own membership through role RPCs", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_role", [w.ownerA.id, "employee"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "remove_member", [w.ownerA.id])), /forbidden/);
    await assert.rejects(asUser(w.db, w.adminA, (q) => rpc(q, "set_member_role", [w.adminA.id, "owner"])), /forbidden/);
  });

  test("the last active owner cannot be demoted, removed, or leave", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "leave_workspace")), /at least one active owner/);
    await assert.rejects(
      w.db.query("update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2", [w.wsA, w.ownerA.id]),
      /at least one active owner/);
    assert.equal(await memberRole(w.wsA, w.ownerA), "owner");
  });

  test("with two owners, an owner may demote the other; every change is audited", async () => {
    await asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_role", [w.adminA.id, "owner"]));
    assert.equal(await memberRole(w.wsA, w.adminA), "owner");
    await asUser(w.db, w.adminA, (q) => rpc(q, "set_member_role", [w.ownerA.id, "admin"]));
    assert.equal(await memberRole(w.wsA, w.ownerA), "admin");
    await asUser(w.db, w.adminA, (q) => rpc(q, "set_member_role", [w.ownerA.id, "owner"]));
    await asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_role", [w.adminA.id, "admin"]));
    const audits = await adminCount(w.db,
      "select count(*) n from public.workspace_audit_log where workspace_id = $1 and action = 'member.role_changed' and metadata ? 'before' and metadata ? 'after'",
      [w.wsA]);
    assert.equal(audits, 4);
  });

  test("an owner of another workspace cannot change memberships here", async () => {
    await assert.rejects(asUser(w.db, w.ownerB, (q) => rpc(q, "set_member_role", [w.employeeA.id, "owner"])), /not_found/);
    await assert.rejects(asUser(w.db, w.ownerB, (q) => rpc(q, "remove_member", [w.employeeA.id])), /not_found/);
    assert.equal(await memberRole(w.wsA, w.employeeA), "employee");
  });

  test("invalid roles, including platform admin, cannot be granted", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "create_invitation", ["p@example.test", "platform_admin", 72])), /validation_failed/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "set_member_role", [w.employeeA.id, "platform_admin"])), /validation_failed/);
    await assert.rejects(
      w.db.query("insert into public.workspace_invitations (workspace_id, email, role, token_hash, expires_at) values ($1, 'p@example.test', 'platform_admin', '\\x01', now() + interval '1 day')", [w.wsA]),
      /check constraint/);
    assert.equal(await adminCount(w.db, "select count(*) n from public.platform_admins"), 1);
  });
});

describe("invitations are single-use, expiring, email-bound, and revocable", () => {
  test("an accepted invitation cannot be used again", async () => {
    const u = await createUser(w.db, "reuse@example.test");
    const token = await invite(w.ownerA, u.email, "employee");
    await asUser(w.db, u, (q) => rpc(q, "accept_invitation", [token]));
    await assert.rejects(asUser(w.db, u, (q) => rpc(q, "accept_invitation", [token])), /invitation_used/);
    const other = await createUser(w.db, "reuse-other@example.test");
    await assert.rejects(asUser(w.db, other, (q) => rpc(q, "accept_invitation", [token])), /invitation_used/);
  });

  test("an expired invitation is rejected and expiry is capped at 7 days", async () => {
    const u = await createUser(w.db, "expired@example.test");
    const token = await invite(w.ownerA, u.email, "employee");
    await w.db.query(
      "update public.workspace_invitations set created_at = now() - interval '4 days', expires_at = now() - interval '1 day' where email = $1",
      [u.email]);
    await assert.rejects(asUser(w.db, u, (q) => rpc(q, "accept_invitation", [token])), /invitation_expired/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "create_invitation", ["long@example.test", "employee", 169])), /validation_failed/);
  });

  test("a revoked invitation is rejected", async () => {
    const u = await createUser(w.db, "revoked@example.test");
    const token = await invite(w.ownerA, u.email, "employee");
    const id = (await w.db.query<{ id: string }>("select id from public.workspace_invitations where email = $1", [u.email])).rows[0].id;
    await asUser(w.db, w.ownerA, (q) => rpc(q, "revoke_invitation", [id]));
    await assert.rejects(asUser(w.db, u, (q) => rpc(q, "accept_invitation", [token])), /invitation_revoked/);
  });

  test("an invitation cannot be accepted by a different email", async () => {
    const intended = await createUser(w.db, "intended@example.test");
    const thief = await createUser(w.db, "thief@example.test");
    const token = await invite(w.ownerA, intended.email, "employee");
    await assert.rejects(asUser(w.db, thief, (q) => rpc(q, "accept_invitation", [token])), /invitation_email_mismatch/);
    await asUser(w.db, intended, (q) => rpc(q, "accept_invitation", [token]));
  });

  test("only the token hash is stored and it is not readable through the API", async () => {
    const token = await invite(w.ownerA, "hash-check@example.test", "employee");
    const stored = await w.db.query<{ token_hash: Uint8Array; matches: boolean; raw_present: boolean }>(
      `select token_hash, token_hash = sha256(convert_to($1, 'UTF8')) as matches,
              position($1 in encode(token_hash, 'escape')) > 0 as raw_present
       from public.workspace_invitations where email = 'hash-check@example.test'`, [token]);
    assert.equal(stored.rows[0].matches, true);
    assert.equal(stored.rows[0].raw_present, false);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("select token_hash from public.workspace_invitations")),
      /permission denied/);
  });

  test("invitation status can be previewed without exposing the email", async () => {
    const token = await invite(w.ownerA, "preview@example.test", "employee");
    const preview = await asUser(w.db, w.outsider, (q) =>
      rpc<{ status: string; email_masked: string; role: string }>(q, "peek_invitation", [token]));
    assert.equal(preview.status, "valid");
    assert.equal(preview.role, "employee");
    assert.equal(preview.email_masked, "p***@example.test");
    const missing = await asUser(w.db, w.outsider, (q) => rpc<{ status: string }>(q, "peek_invitation", ["nope"]));
    assert.equal(missing.status, "not_found");
  });
});

describe("removed members lose access immediately", () => {
  let victim: TestUser;
  let contact: string;

  before(async () => {
    victim = await createUser(w.db, "victim@example.test");
    const firstToken = await invite(w.ownerA, victim.email, "employee");
    await asUser(w.db, victim, (q) => rpc(q, "accept_invitation", [firstToken]));
    contact = await createContact(w.db, w.ownerA, w.wsA, "Assigned contact");
    const stage = await stageId(w.db, w.ownerA, 1);
    await asUser(w.db, w.ownerA, async (q) => {
      await q.query("update public.contacts set owner_user_id = $1 where id = $2", [victim.id, contact]);
      await q.query(
        `insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title, assigned_user_id)
         values ($1, $2, $3, $4, 'assigned', $5)`,
        [w.wsA, contact, stage.pipeline_id, stage.id, victim.id]);
      await q.query(
        "insert into public.tasks (workspace_id, title, assigned_user_id) values ($1, 'assigned task', $2)",
        [w.wsA, victim.id]);
    });
    await asUser(w.db, victim, async (q) => {
      const r = await rows<{ n: number }>(q, "select count(*)::int n from public.contacts");
      assert.ok(r[0].n > 0, "victim should see contacts before removal");
    });
    await asUser(w.db, w.ownerA, (q) => rpc(q, "remove_member", [victim.id]));
  });

  test("the same JWT now reads zero rows and has no workspace context", async () => {
    await asUser(w.db, victim, async (q) => {
      for (const t of ["contacts", "opportunities", "tasks", "pipeline_stages", "workspace_members", "workspace_settings"]) {
        const r = await rows<{ n: number }>(q, `select count(*)::int n from public.${t}`);
        assert.equal(r[0].n, 0, `removed member still sees ${t}`);
      }
      const ctx = await rpc<{ workspace: unknown; permissions: string[] }>(q, "request_context");
      assert.equal(ctx.workspace, null);
      assert.deepEqual(ctx.permissions, []);
    });
  });

  test("the removed member cannot write or switch back", async () => {
    await assert.rejects(
      asUser(w.db, victim, (q) => q.query(
        "insert into public.contacts (workspace_id, first_name) values ($1, 'x')", [w.wsA])),
      /row-level security/);
    await assert.rejects(asUser(w.db, victim, (q) => rpc(q, "switch_workspace", [w.wsA])), /forbidden/);
  });

  test("their assignments were cleared in the same transaction and the removal was audited", async () => {
    assert.equal(await adminCount(w.db, "select count(*) n from public.opportunities where assigned_user_id = $1", [victim.id]), 0);
    assert.equal(await adminCount(w.db, "select count(*) n from public.tasks where assigned_user_id = $1", [victim.id]), 0);
    assert.equal(await adminCount(w.db, "select count(*) n from public.contacts where owner_user_id = $1", [victim.id]), 0);
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.workspace_audit_log where action = 'member.removed' and target = $1", [victim.id]), 1);
  });

  test("a removed member cannot be newly assigned", async () => {
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.tasks (workspace_id, title, assigned_user_id) values ($1, 't', $2)",
        [w.wsA, victim.id])),
      /active member of the same workspace/);
  });

  test("re-inviting reactivates the same membership row with the new role", async () => {
    const token = await invite(w.ownerA, victim.email, "employee");
    await asUser(w.db, victim, (q) => rpc(q, "accept_invitation", [token]));
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.workspace_members where workspace_id = $1 and user_id = $2", [w.wsA, victim.id]), 1);
    assert.equal(await memberRole(w.wsA, victim), "employee");
  });
});

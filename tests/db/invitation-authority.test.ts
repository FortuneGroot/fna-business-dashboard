import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { accept, asUser, buildWorld, createUser, invite, rpc, type World } from "./harness";

// M24: an open invitation never outlives its creator's authority. Without it, an owner who invited a
// second address of their own could be demoted or removed and then accept that invitation to return
// as owner (and remove the owner who demoted them).

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

async function invitationState(email: string): Promise<{ revoked: boolean; accepted: boolean }> {
  const r = await w.db.query<{ revoked: boolean; accepted: boolean }>(
    `select revoked_at is not null revoked, accepted_at is not null accepted
     from public.workspace_invitations where workspace_id = $1 and email = $2 order by created_at desc limit 1`, [w.wsA, email]);
  return r.rows[0];
}

async function revocationAudits(email: string): Promise<{ actor_id: string; actor_kind: string; reason: string }[]> {
  const r = await w.db.query<{ actor_id: string; actor_kind: string; reason: string }>(
    `select a.actor_id, a.actor_kind, a.metadata->>'reason' reason from public.workspace_audit_log a
     join public.workspace_invitations i on i.id::text = a.target
     where a.workspace_id = $1 and a.action = 'invitation.revoked' and i.email = $2`, [w.wsA, email]);
  return r.rows;
}

describe("M24: invitations end with their creator's authority", () => {
  test("demotion revokes the invitations the new role cannot issue; removal revokes the rest; the alt address cannot get back in", async () => {
    const second = await createUser(w.db, "second-owner@example.test");
    await accept(w.db, second, await invite(w.db, w.ownerA, second.email, "owner"));

    const ownerToken = await invite(w.db, w.ownerA, "alt-owner@example.test", "owner");
    await invite(w.db, w.ownerA, "alt-admin@example.test", "admin");
    await invite(w.db, w.ownerA, "alt-employee@example.test", "employee");

    await asUser(w.db, second, (q) => rpc(q, "set_member_role", [w.ownerA.id, "admin"]));
    assert.deepEqual(await invitationState("alt-owner@example.test"), { revoked: true, accepted: false });
    assert.deepEqual(await invitationState("alt-admin@example.test"), { revoked: true, accepted: false });
    assert.deepEqual(await invitationState("alt-employee@example.test"), { revoked: false, accepted: false },
      "an admin may still invite employees, so that invitation stays open");
    assert.deepEqual(await revocationAudits("alt-owner@example.test"),
      [{ actor_id: second.id, actor_kind: "member", reason: "inviter_role_changed" }]);

    await asUser(w.db, second, (q) => rpc(q, "remove_member", [w.ownerA.id]));
    assert.deepEqual(await invitationState("alt-employee@example.test"), { revoked: true, accepted: false });
    assert.deepEqual(await revocationAudits("alt-employee@example.test"),
      [{ actor_id: second.id, actor_kind: "member", reason: "inviter_removed" }]);

    const alt = await createUser(w.db, "alt-owner@example.test");
    await assert.rejects(accept(w.db, alt, ownerToken), /invitation_revoked/);
    const status = await w.db.query<{ role: string | null }>(
      "select role from public.workspace_members where workspace_id = $1 and user_id = $2 and status = 'active'", [w.wsA, alt.id]);
    assert.equal(status.rows.length, 0);
  });

  test("a revoked invitation token is refused at acceptance", async () => {
    const leaver = await createUser(w.db, "leaving-admin@example.test");
    await accept(w.db, leaver, await invite(w.db, w.ownerB, leaver.email, "admin"));
    const token = await invite(w.db, leaver, "leaver-friend@example.test", "employee");
    await asUser(w.db, leaver, (q) => rpc(q, "leave_workspace"));
    const friend = await createUser(w.db, "leaver-friend@example.test");
    await assert.rejects(accept(w.db, friend, token), /invitation_revoked/);
    const audit = await w.db.query<{ actor_id: string; actor_kind: string }>(
      `select actor_id, actor_kind from public.workspace_audit_log
       where workspace_id = $1 and action = 'invitation.revoked' and metadata->>'reason' = 'inviter_removed'
       order by created_at desc limit 1`, [w.wsB]);
    assert.deepEqual(audit.rows[0], { actor_id: leaver.id, actor_kind: "member" }, "a member who leaves is attributed as a member");
  });

  test("removing a member leaves invitations created by others open", async () => {
    const keep = await invite(w.db, w.ownerB, "kept-invite@example.test", "employee");
    const other = await createUser(w.db, "other-admin@example.test");
    await accept(w.db, other, await invite(w.db, w.ownerB, other.email, "admin"));
    await asUser(w.db, w.ownerB, (q) => rpc(q, "remove_member", [other.id]));
    const kept = await createUser(w.db, "kept-invite@example.test");
    await accept(w.db, kept, keep);
  });
});

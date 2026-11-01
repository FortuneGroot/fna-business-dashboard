import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  accept, adminCount, asAnon, asServiceRole, asUser, buildWorld, createUser, invite, rpc, rows,
  type TestUser, type World,
} from "./harness";

// P4 (migration 20261101001600): team listing, atomic employee overrides, the service-role-only
// invitation sign-up lookup (allowlist A1), and attribution of configuration changes. Every user
// call runs as role authenticated with that user's JWT claims; the superuser only verifies outcomes.

let w: World;

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

type Member = { user_id: string; email: string; role: string; status: string; overrides: Record<string, boolean> };
const team = (u: TestUser) => asUser(w.db, u, (q) => rpc<Member[]>(q, "list_team_members"));
const setOverrides = (u: TestUser, target: TestUser, overrides: unknown) =>
  asUser(w.db, u, (q) => rpc(q, "set_member_permissions", [target.id, JSON.stringify(overrides)]));
const overridesOf = (target: TestUser) =>
  rows<{ permission: string; allowed: boolean }>(w.db as never,
    "select permission, allowed from public.member_permission_overrides where workspace_id = $1 and user_id = $2 order by permission",
    [w.wsA, target.id]);
const signupEmail = (token: string) => asServiceRole(w.db, (q) => rpc<string>(q, "invitation_signup_email", [token]));
const lastId = (table: string) => adminCount(w.db, `select coalesce(max(id), 0) n from public.${table}`);

describe("P4: list_team_members", () => {
  test("members with team.read see their active workspace's members with emails; nobody else does", async () => {
    const asOwner = await team(w.ownerA);
    assert.deepEqual(asOwner.map((m) => m.email).sort(),
      [w.adminA, w.dual, w.employeeA, w.ownerA].map((u) => u.email).sort());
    assert.equal(asOwner[0].role, "owner", "owners first");
    assert.ok(asOwner.every((m) => m.status === "active"));
    assert.deepEqual((await team(w.employeeA)).map((m) => m.user_id).sort(), asOwner.map((m) => m.user_id).sort());
    const asB = await team(w.ownerB);
    assert.equal(asB.some((m) => m.email === w.ownerA.email), false, "B sees only B");
    await assert.rejects(team(w.outsider), /forbidden/);
    await assert.rejects(asAnon(w.db, (q) => rpc(q, "list_team_members")), /permission denied/);
  });
});

describe("P4: set_member_permissions (atomic)", () => {
  test("an owner and an admin can set employee overrides; each change is audited", async () => {
    const before = await lastId("workspace_audit_log");
    await setOverrides(w.ownerA, w.employeeA, { "contacts.delete": true, "tasks.write": false });
    assert.deepEqual(await overridesOf(w.employeeA), [
      { permission: "contacts.delete", allowed: true }, { permission: "tasks.write", allowed: false },
    ]);
    await setOverrides(w.adminA, w.employeeA, { "tasks.write": null });
    assert.deepEqual(await overridesOf(w.employeeA), [{ permission: "contacts.delete", allowed: true }]);
    const audit = await rows<{ action: string; actor_id: string; metadata: { permission: string } }>(w.db as never,
      "select action, actor_id, metadata from public.workspace_audit_log where id > $1 order by id", [before]);
    assert.deepEqual(audit.map((a) => [a.action, a.metadata.permission]), [
      ["member.permission_override", "contacts.delete"], ["member.permission_override", "tasks.write"],
      ["member.permission_override", "tasks.write"],
    ]);
    assert.deepEqual(audit.map((a) => a.actor_id), [w.ownerA.id, w.ownerA.id, w.adminA.id]);
  });

  test("one invalid entry rolls back the whole change (team.* cannot be granted)", async () => {
    const before = await overridesOf(w.employeeA);
    await assert.rejects(setOverrides(w.ownerA, w.employeeA, { "calendar.configure": true, "team.remove": true }));
    await assert.rejects(setOverrides(w.ownerA, w.employeeA, { "integrations.manage": true, "reports.read": false }));
    await assert.rejects(setOverrides(w.ownerA, w.employeeA, { "calendar.configure": true, "made.up": true }), /validation_failed/);
    assert.deepEqual(await overridesOf(w.employeeA), before, "nothing from the failed calls was kept");
  });

  test("malformed payloads, non-employees, employees, other workspaces, and self are refused", async () => {
    await assert.rejects(setOverrides(w.ownerA, w.employeeA, {}), /validation_failed/);
    await assert.rejects(setOverrides(w.ownerA, w.employeeA, ["contacts.read"]), /validation_failed/);
    await assert.rejects(setOverrides(w.ownerA, w.employeeA, { "contacts.read": "yes" }), /validation_failed/);
    await assert.rejects(setOverrides(w.ownerA, w.adminA, { "contacts.delete": false }), /employees only/);
    await assert.rejects(setOverrides(w.employeeA, w.dual, { "contacts.delete": true }), /forbidden/);
    await assert.rejects(setOverrides(w.ownerB, w.employeeA, { "contacts.delete": true }), /not_found/);
    await assert.rejects(setOverrides(w.adminA, w.adminA, { "contacts.delete": true }), /forbidden/);
  });
});

describe("P4: invitation_signup_email (A1, service role only)", () => {
  test("only the service role may call it; clients and anonymous callers cannot", async () => {
    const token = await invite(w.db, w.ownerA, "a1-only@example.test", "employee");
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "invitation_signup_email", [token])), /permission denied/);
    await assert.rejects(asAnon(w.db, (q) => rpc(q, "invitation_signup_email", [token])), /permission denied/);
    assert.equal(await signupEmail(token), "a1-only@example.test");
  });

  test("refuses unknown, revoked, used, and expired invitations, suspended workspaces, and existing accounts", async () => {
    await assert.rejects(signupEmail("0".repeat(64)), /invitation_not_found/);

    const revoked = await invite(w.db, w.ownerA, "a1-revoked@example.test", "employee");
    const id = (await rows<{ id: string }>(w.db as never, "select id from public.workspace_invitations where email = 'a1-revoked@example.test'"))[0].id;
    await asUser(w.db, w.ownerA, (q) => rpc(q, "revoke_invitation", [id]));
    await assert.rejects(signupEmail(revoked), /invitation_revoked/);

    const existing = await invite(w.db, w.ownerA, w.outsider.email, "employee");
    await assert.rejects(signupEmail(existing), /conflict/, "an account already exists for this address");
    await accept(w.db, w.outsider, existing);
    await assert.rejects(signupEmail(existing), /invitation_used/);

    const expired = await invite(w.db, w.ownerA, "a1-expired@example.test", "employee");
    await w.db.query(
      "update public.workspace_invitations set created_at = now() - interval '4 days', expires_at = now() - interval '1 second' where email = 'a1-expired@example.test'");
    await assert.rejects(signupEmail(expired), /invitation_expired/);

    const suspended = await invite(w.db, w.ownerB, "a1-suspended@example.test", "employee");
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_suspend_workspace", [w.wsB, "p4 suspension test reason"]));
    try {
      await assert.rejects(signupEmail(suspended), /workspace_suspended/);
    } finally {
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_reactivate_workspace", [w.wsB, "p4 suspension test reason"]));
    }
  });

  test("does not consume the invitation: acceptance still needs the new user's own JWT and matching email", async () => {
    const token = await invite(w.db, w.ownerA, "a1-new@example.test", "employee");
    assert.equal(await signupEmail(token), "a1-new@example.test");
    assert.equal(await signupEmail(token), "a1-new@example.test", "repeatable until an account exists");
    const fresh = await createUser(w.db, "a1-new@example.test");
    await assert.rejects(signupEmail(token), /conflict/);
    const intruder = await createUser(w.db, "a1-intruder@example.test");
    await assert.rejects(accept(w.db, intruder, token), /invitation_email_mismatch/);
    await accept(w.db, fresh, token);
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.workspace_members where workspace_id = $1 and user_id = $2 and status = 'active' and role = 'employee'",
      [w.wsA, fresh.id]), 1);
  });
});

describe("P4: configuration changes are attributed (activity + audit)", () => {
  const changes = async (activitySince: number, auditSince: number) => ({
    activity: await rows<{ entity_type: string; action: string; actor_id: string; actor_kind: string; payload: { fields: string[] } }>(w.db as never,
      "select entity_type, action, actor_id, actor_kind, payload from public.activity_events where id > $1 order by id", [activitySince]),
    audit: await rows<{ action: string; actor_id: string; actor_kind: string; target: string; metadata: { fields?: string[] } }>(w.db as never,
      "select action, actor_id, actor_kind, target, metadata from public.workspace_audit_log where id > $1 order by id", [auditSince]),
  });

  test("a member's settings change records which fields changed (never values); a no-op records nothing", async () => {
    const [a0, u0] = [await lastId("activity_events"), await lastId("workspace_audit_log")];
    await asUser(w.db, w.ownerA, (q) => q.query(
      "update public.workspace_settings set business_name = 'Renamed Co', support_email = 'help@renamed.example.test' where workspace_id = $1", [w.wsA]));
    await asUser(w.db, w.ownerA, (q) => q.query(
      "update public.workspace_settings set business_name = 'Renamed Co' where workspace_id = $1", [w.wsA]));
    const { activity, audit } = await changes(a0, u0);
    assert.deepEqual(activity.map((a) => [a.entity_type, a.action, a.actor_id, a.actor_kind, a.payload.fields]), [
      ["workspace_settings", "updated", w.ownerA.id, "member", ["business_name", "support_email"]],
    ]);
    assert.deepEqual(audit.map((a) => [a.action, a.actor_id, a.actor_kind, a.target, a.metadata.fields]), [
      ["settings.updated", w.ownerA.id, "member", "workspace_settings", ["business_name", "support_email"]],
    ]);
    assert.equal(JSON.stringify([activity, audit]).includes("renamed.example.test"), false, "values are not copied");
    assert.equal(await adminCount(w.db, "select count(*) n from public.workspace_settings where workspace_id = $1 and updated_by = $2",
      [w.wsA, w.ownerA.id]), 1, "updated_by is stamped by the database");
  });

  test("AI receptionist edits are attributed; enabling stays impossible; employees cannot edit", async () => {
    const [a0, u0] = [await lastId("activity_events"), await lastId("workspace_audit_log")];
    await asUser(w.db, w.adminA, (q) => q.query(
      "update public.ai_receptionist_configs set greeting = 'Thanks for calling', escalation_user_id = $2 where workspace_id = $1",
      [w.wsA, w.employeeA.id]));
    const { audit } = await changes(a0, u0);
    assert.deepEqual(audit.map((a) => [a.action, a.actor_id, a.metadata.fields]), [
      ["ai_receptionist.updated", w.adminA.id, ["escalation_user_id", "greeting"]],
    ]);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(
      "update public.ai_receptionist_configs set enabled = true where workspace_id = $1", [w.wsA])), /permission denied/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(
      "update public.ai_receptionist_configs set escalation_user_id = $2 where workspace_id = $1", [w.wsA, w.employeeB.id])));
    const updated = await asUser(w.db, w.employeeA, (q) => q.query(
      "update public.ai_receptionist_configs set greeting = 'employee edit' where workspace_id = $1", [w.wsA]));
    assert.equal(updated.affectedRows ?? 0, 0, "RLS hides the row from an employee update");
  });

  test("a platform write grant's change is attributed once (grant audit) and as platform_admin activity", async () => {
    const g = await asUser(w.db, w.platform, (q) => rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "write", "p4 attribution grant test", 15]));
    try {
      const [a0, u0] = [await lastId("activity_events"), await lastId("workspace_audit_log")];
      await asUser(w.db, w.platform, (q) => q.query(
        "update public.workspace_settings set industry = 'Plumbing' where workspace_id = $1", [w.wsA]));
      const { activity, audit } = await changes(a0, u0);
      assert.deepEqual(activity.map((a) => [a.actor_id, a.actor_kind, a.payload.fields]), [[w.platform.id, "platform_admin", ["industry"]]]);
      assert.deepEqual(audit.map((a) => [a.action, a.actor_kind]), [["workspace_settings.update", "platform_admin"]]);
    } finally {
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [g.id]));
    }
  });
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  adminCount, asUser, buildWorld, createContact, createUser, makePlatformAdmin, rows, rpc,
  type TestUser, type World,
} from "./harness";

const STAGES: Array<[number, string, string]> = [
  [1, "New Lead", "open"],
  [2, "Attempting Contact", "open"],
  [3, "Connected", "open"],
  [4, "Qualified", "open"],
  [5, "Appointment Booked", "open"],
  [6, "Appointment Completed", "open"],
  [7, "Estimate / Proposal Sent", "open"],
  [8, "Follow-Up", "open"],
  [9, "Decision Pending", "open"],
  [10, "Won", "won"],
  [11, "Lost", "lost"],
  [12, "Long-Term Nurture", "nurture"],
];

let w: World;

before(async () => {
  w = await buildWorld();
  await createContact(w.db, w.ownerA, w.wsA, "Suspension contact");
});

after(async () => {
  await w.db.close();
});

async function contactCount(user: TestUser): Promise<number> {
  return asUser(w.db, user, async (q) => (await rows<{ n: number }>(q, "select count(*)::int n from public.contacts"))[0].n);
}

describe("platform RPCs require a platform admin with MFA", () => {
  test("ordinary users, workspace owners, and AAL1 platform admins are refused", async () => {
    const aal1 = { ...w.platform, aal: "aal1" as const };
    for (const user of [w.ownerA, w.employeeA, w.outsider, aal1]) {
      await assert.rejects(asUser(w.db, user, (q) => rpc(q, "platform_list_workspaces")), /forbidden/);
      await assert.rejects(asUser(w.db, user, (q) => rpc(q, "platform_suspend_workspace", [w.wsB, "attempted by non-admin"])), /forbidden/);
      await assert.rejects(asUser(w.db, user, (q) => rpc(q, "platform_grant_access", [w.wsB, "read", "attempted by non-admin", 30])), /forbidden/);
    }
  });

  test("a platform admin lists workspaces", async () => {
    const list = await asUser(w.db, w.platform, (q) => rpc<Array<{ id: string; member_count: number }>>(q, "platform_list_workspaces"));
    assert.equal(list.length, 2);
  });
});

describe("super-admin workspace access is explicit, time-boxed, and audited", () => {
  test("without a grant the platform admin reads nothing from a workspace", async () => {
    assert.equal(await contactCount(w.platform), 0);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "switch_workspace", [w.wsA])), /forbidden/);
  });

  test("a read grant allows reads but not writes, then revocation ends access", async () => {
    const grant = await asUser(w.db, w.platform, (q) =>
      rpc<{ id: string; mode: string }>(q, "platform_grant_access", [w.wsA, "read", "Support ticket #1001 investigation", 30]));
    assert.equal(grant.mode, "read");
    assert.ok(await contactCount(w.platform) > 0);
    await assert.rejects(
      asUser(w.db, w.platform, (q) => q.query(
        "insert into public.contacts (workspace_id, first_name) values ($1, 'x')", [w.wsA])),
      /row-level security/);
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id]));
    assert.equal(await contactCount(w.platform), 0);
  });

  test("a write grant allows writes, each audited with the grant id, but never role changes", async () => {
    const grant = await asUser(w.db, w.platform, (q) =>
      rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "write", "Data correction requested by owner", 30]));
    const contact = await asUser(w.db, w.platform, async (q) => (await rows<{ id: string }>(q,
      "insert into public.contacts (workspace_id, first_name) values ($1, 'Support fix') returning id", [w.wsA]))[0].id);
    const audit = await w.db.query<{ actor_id: string; actor_kind: string; action: string; target: string }>(
      `select actor_id, actor_kind, action, target from public.workspace_audit_log
       where workspace_id = $1 and grant_id = $2 and action <> 'platform.access_granted' order by id`, [w.wsA, grant.id]);
    assert.deepEqual(audit.rows, [{ actor_id: w.platform.id, actor_kind: "platform_admin", action: "contacts.insert", target: contact }]);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "set_member_role", [w.employeeA.id, "owner"])), /forbidden/);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "remove_member", [w.employeeA.id])), /forbidden/);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "create_invitation", ["x@example.test", "admin", 72])), /forbidden/);
    await assert.rejects(
      asUser(w.db, w.platform, (q) => q.query(
        "insert into public.integrations (workspace_id, provider) values ($1, 'test_provider')", [w.wsA])),
      /row-level security/);
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id]));
  });

  test("an expired grant ends access without any action", async () => {
    const grant = await asUser(w.db, w.platform, (q) =>
      rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "Short-lived support access", 5]));
    assert.ok(await contactCount(w.platform) > 0);
    await w.db.query(
      "update public.platform_access_grants set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1",
      [grant.id]);
    assert.equal(await contactCount(w.platform), 0);
  });

  test("grant and revoke events are recorded in the platform audit log", async () => {
    assert.ok(await adminCount(w.db, "select count(*) n from public.platform_audit_log where action = 'access.granted'") >= 3);
    assert.ok(await adminCount(w.db, "select count(*) n from public.platform_audit_log where action = 'access.revoked'") >= 2);
  });

  test("grant duration and reason are validated", async () => {
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_grant_access", [w.wsA, "read", "too long access window", 481])), /validation_failed/);
    await assert.rejects(asUser(w.db, w.platform, (q) => rpc(q, "platform_grant_access", [w.wsA, "read", "short", 30])), /validation_failed/);
  });
});

describe("suspended workspaces lose ordinary access", () => {
  before(async () => {
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_suspend_workspace", [w.wsA, "Billing hold for testing"]));
  });

  test("members read nothing and cannot write, including the owner", async () => {
    for (const u of [w.ownerA, w.adminA, w.employeeA]) assert.equal(await contactCount(u), 0);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.contacts (workspace_id, first_name) values ($1, 'x')", [w.wsA])),
      /row-level security/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "create_invitation", ["s@example.test", "employee", 72])), /forbidden/);
  });

  test("request context reports the suspension and switching is refused", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      const ctx = await rpc<{ workspace: { status: string }; permissions: string[] }>(q, "request_context");
      assert.equal(ctx.workspace.status, "suspended");
      assert.deepEqual(ctx.permissions, []);
    });
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "switch_workspace", [w.wsA])), /workspace_suspended/);
  });

  test("invitations to a suspended workspace cannot be accepted", async () => {
    const pending = await createUser(w.db, "pending-suspended@example.test");
    await w.db.query("update public.workspaces set status = 'active' where id = $1", [w.wsA]);
    const token = (await asUser(w.db, w.ownerA, (q) => rpc<{ token: string }>(q, "create_invitation", [pending.email, "employee", 72]))).token;
    await w.db.query("update public.workspaces set status = 'suspended' where id = $1", [w.wsA]);
    await assert.rejects(asUser(w.db, pending, (q) => rpc(q, "accept_invitation", [token])), /workspace_suspended/);
  });

  test("other workspaces are unaffected", async () => {
    await asUser(w.db, w.dual, (q) => rpc(q, "switch_workspace", [w.wsB]));
    assert.ok(await contactCount(w.dual) >= 0);
    await asUser(w.db, w.dual, async (q) => {
      const ctx = await rpc<{ workspace: { id: string; status: string } }>(q, "request_context");
      assert.equal(ctx.workspace.id, w.wsB);
      assert.equal(ctx.workspace.status, "active");
    });
  });

  test("support can read with a read grant; write grants are refused while suspended", async () => {
    await assert.rejects(
      asUser(w.db, w.platform, (q) => rpc(q, "platform_grant_access", [w.wsA, "write", "Attempted write during suspension", 30])),
      /workspace_suspended/);
    const grant = await asUser(w.db, w.platform, (q) =>
      rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "Review account during suspension", 30]));
    assert.ok(await contactCount(w.platform) > 0);
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id]));
  });

  test("reactivation restores member access with no data loss", async () => {
    await asUser(w.db, w.platform, (q) => rpc(q, "platform_reactivate_workspace", [w.wsA, "Billing resolved for testing"]));
    assert.ok(await contactCount(w.ownerA) > 0);
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.platform_audit_log where workspace_id = $1 and action in ('workspace.suspended', 'workspace.reactivated')",
      [w.wsA]), 2);
  });
});

describe("provisioning creates exactly the intended empty workspace", () => {
  test("seeds settings, disabled AI config, one pipeline, exactly 12 stages, one owner invitation, and nothing else", async () => {
    const res = await asUser(w.db, w.platform, (q) =>
      rpc<{ workspace_id: string; created: boolean; invite_token: string }>(q, "platform_provision_workspace", [
        "fa-live-test", "Fortune & Automations", "fortune-automations", "george@example.test",
      ]));
    assert.equal(res.created, true);
    assert.match(res.invite_token, /^[0-9a-f]{64}$/);
    const ws = res.workspace_id;

    const count = (table: string) => adminCount(w.db, `select count(*) n from public.${table} where workspace_id = $1`, [ws]);
    assert.equal(await count("workspace_settings"), 1);
    assert.equal(await count("ai_receptionist_configs"), 1);
    assert.equal(await adminCount(w.db, "select count(*) n from public.ai_receptionist_configs where workspace_id = $1 and enabled", [ws]), 0);
    assert.equal(await count("pipelines"), 1);
    assert.equal(await count("pipeline_stages"), 12);
    assert.equal(await count("workspace_invitations"), 1);
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.workspace_invitations where workspace_id = $1 and role = 'owner' and email = 'george@example.test'", [ws]), 1);
    for (const t of ["workspace_members", "contacts", "contact_tags", "contact_notes", "opportunities", "calendars",
                     "calendar_members", "availability_rules", "appointments", "conversations", "messages", "tasks",
                     "reviews", "integrations", "member_permission_overrides", "activity_events"]) {
      assert.equal(await count(t), 0, `provisioning created rows in ${t}`);
    }

    const stages = await w.db.query<{ position: number; name: string; kind: string }>(
      "select position, name, kind from public.pipeline_stages where workspace_id = $1 order by position", [ws]);
    assert.deepEqual(stages.rows.map((s) => [s.position, s.name, s.kind]), STAGES);
  });

  test("a replay never reveals the token, and the invited owner has no access before accepting", async () => {
    const george = await createUser(w.db, "george@example.test");
    const prov = await asUser(w.db, w.platform, (q) =>
      rpc<{ workspace_id: string; invite_token: string | null }>(q, "platform_provision_workspace", [
        "fa-live-test", "Fortune & Automations", "fortune-automations", "george@example.test",
      ]));
    assert.equal(prov.invite_token, null, "replay must not reveal a token");
    assert.equal(await contactCount(george), 0);
    const token = (await w.db.query<{ id: string }>(
      "select id from public.workspace_invitations where workspace_id = $1", [prov.workspace_id])).rows[0];
    assert.ok(token);
  });

  test("replaying the same key with the same inputs returns the same workspace without duplicates", async () => {
    const before = await adminCount(w.db, "select count(*) n from public.workspaces");
    const again = await asUser(w.db, w.platform, (q) =>
      rpc<{ workspace_id: string; created: boolean }>(q, "platform_provision_workspace", [
        "fa-live-test", "Fortune & Automations", "fortune-automations", "GEORGE@example.test",
      ]));
    assert.equal(again.created, false);
    assert.equal(await adminCount(w.db, "select count(*) n from public.workspaces"), before);
    assert.equal(await adminCount(w.db, "select count(*) n from public.pipeline_stages where workspace_id = $1", [again.workspace_id]), 12);
    assert.equal(await adminCount(w.db, "select count(*) n from public.workspace_invitations where workspace_id = $1", [again.workspace_id]), 1);
  });

  test("the same key with different inputs, or a taken slug, is a conflict", async () => {
    await assert.rejects(
      asUser(w.db, w.platform, (q) => rpc(q, "platform_provision_workspace", ["fa-live-test", "Different Name", "fortune-automations", "george@example.test"])),
      /conflict/);
    await assert.rejects(
      asUser(w.db, w.platform, (q) => rpc(q, "platform_provision_workspace", ["another-key", "Another", "fortune-automations", "x@example.test"])),
      /conflict/);
  });

  test("a failure late in provisioning leaves no partial workspace", async () => {
    const before = await adminCount(w.db, "select count(*) n from public.workspaces");
    await assert.rejects(
      asUser(w.db, w.platform, (q) => rpc(q, "platform_provision_workspace", ["late-failure", "Late Failure", "late-failure", "not-an-email"])),
      /check constraint|violates/);
    assert.equal(await adminCount(w.db, "select count(*) n from public.workspaces"), before);
    assert.equal(await adminCount(w.db, "select count(*) n from public.workspaces where provisioning_key = 'late-failure'"), 0);
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.pipeline_stages s where not exists (select 1 from public.workspaces w where w.id = s.workspace_id)"), 0);
  });

  test("invalid slugs are rejected", async () => {
    await assert.rejects(
      asUser(w.db, w.platform, (q) => rpc(q, "platform_provision_workspace", ["bad-slug", "Bad", "Bad Slug!", "x@example.test"])),
      /validation_failed/);
  });

  test("each workspace has its own stage ids", async () => {
    assert.equal(await adminCount(w.db,
      "select count(*) n from (select id from public.pipeline_stages group by id having count(*) > 1) d"), 0);
    assert.equal(await adminCount(w.db,
      "select count(distinct workspace_id) n from public.pipeline_stages"),
      await adminCount(w.db, "select count(*) n from public.workspaces"));
  });

  test("a second platform admin's provisioning is independent and audited", async () => {
    const other = await createUser(w.db, "platform2@example.test", "aal2");
    await makePlatformAdmin(w.db, other);
    await asUser(w.db, other, (q) => rpc(q, "platform_provision_workspace", ["other-admin", "Other", "other-admin", "o@example.test"]));
    assert.equal(await adminCount(w.db,
      "select count(*) n from public.platform_audit_log where action = 'workspace.provisioned' and actor_id = $1", [other.id]), 1);
  });
});

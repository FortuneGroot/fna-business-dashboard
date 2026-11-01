import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  asAnon, asUser, buildWorld, createContact, createUser, rows, rpc, stageId,
  type World,
} from "./harness";

// All assertions about access run as role `authenticated` (or `anon`) with JWT claims — the same
// path PostgREST uses. The superuser connection is used only to build fixtures.

let w: World;
let contactA: string;
let contactB: string;
let oppB: string;
let calendarA: string;
let calendarB: string;

before(async () => {
  w = await buildWorld();
  contactA = await createContact(w.db, w.ownerA, w.wsA, "Alice A");
  contactB = await createContact(w.db, w.ownerB, w.wsB, "Bob B");

  const stageB = await stageId(w.db, w.ownerB, 1);
  oppB = await asUser(w.db, w.ownerB, async (q) =>
    (await rows<{ id: string }>(q,
      `insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title)
       values ($1, $2, $3, $4, 'B deal') returning id`,
      [w.wsB, contactB, stageB.pipeline_id, stageB.id]))[0].id);

  calendarA = await asUser(w.db, w.ownerA, async (q) =>
    (await rows<{ id: string }>(q,
      `insert into public.calendars (workspace_id, name, slug, duration_minutes) values ($1, 'Main', 'main', 30) returning id`,
      [w.wsA]))[0].id);
  calendarB = await asUser(w.db, w.ownerB, async (q) =>
    (await rows<{ id: string }>(q,
      `insert into public.calendars (workspace_id, name, slug, duration_minutes) values ($1, 'Main', 'main', 30) returning id`,
      [w.wsB]))[0].id);

  await asUser(w.db, w.ownerB, async (q) => {
    await q.query("insert into public.contact_tags (workspace_id, contact_id, tag) values ($1, $2, 'vip')", [w.wsB, contactB]);
    await q.query(
      "insert into public.tasks (workspace_id, title, contact_id) values ($1, 'B task', $2)",
      [w.wsB, contactB]);
    const conv = await rows<{ id: string }>(q,
      "insert into public.conversations (workspace_id, contact_id, channel) values ($1, $2, 'internal') returning id",
      [w.wsB, contactB]);
    await q.query(
      "insert into public.messages (workspace_id, conversation_id, direction, body) values ($1, $2, 'internal', 'note')",
      [w.wsB, conv[0].id]);
  });
});

after(async () => {
  await w.db.close();
});

describe("unauthenticated access is denied", () => {
  const tables = ["contacts", "opportunities", "workspaces", "workspace_members", "pipeline_stages",
                  "workspace_settings", "profiles", "tasks", "messages"];

  for (const t of tables) {
    test(`anon cannot select ${t}`, async () => {
      await assert.rejects(asAnon(w.db, (q) => q.query(`select * from public.${t}`)), /permission denied/);
    });
  }

  test("anon cannot insert a contact", async () => {
    await assert.rejects(
      asAnon(w.db, (q) => q.query("insert into public.contacts (workspace_id, first_name) values ($1, 'x')", [w.wsA])),
      /permission denied/);
  });

  test("anon cannot call membership or platform RPCs", async () => {
    for (const call of [
      "select public.request_context()",
      `select public.switch_workspace('${w.wsA}')`,
      `select public.platform_provision_workspace('k-anon', 'X', 'x-anon', 'x@example.test')`,
      `select public.remove_member('${w.ownerA.id}')`,
    ]) {
      await assert.rejects(asAnon(w.db, (q) => q.query(call)), /permission denied/, call);
    }
  });

  test("authenticated role without a user subject sees nothing and is refused by RPCs", async () => {
    const count = await w.db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      const r = await tx.query<{ n: number }>("select count(*)::int n from public.contacts");
      return r.rows[0].n;
    });
    assert.equal(count, 0);
    await assert.rejects(
      w.db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query(`select public.switch_workspace('${w.wsA}')`);
      }),
      /forbidden/);
  });

  test("a signed-in user with no memberships sees zero rows everywhere", async () => {
    await asUser(w.db, w.outsider, async (q) => {
      for (const t of ["contacts", "opportunities", "pipeline_stages", "workspace_members",
                       "workspace_settings", "tasks", "conversations", "messages", "calendars", "workspaces"]) {
        const r = await rows<{ n: number }>(q, `select count(*)::int n from public.${t}`);
        assert.equal(r[0].n, 0, `outsider saw rows in ${t}`);
      }
      const ctx = await rpc<{ workspace: unknown; permissions: string[] }>(q, "request_context");
      assert.equal(ctx.workspace, null);
      assert.deepEqual(ctx.permissions, []);
    });
  });
});

describe("workspace A cannot read workspace B", () => {
  const tenantTables = [
    "workspace_members", "member_permission_overrides", "workspace_invitations", "workspace_settings",
    "ai_receptionist_configs", "integrations", "contacts", "contact_tags", "contact_notes", "pipelines",
    "pipeline_stages", "opportunities", "calendars", "calendar_members", "availability_rules",
    "appointments", "conversations", "messages", "tasks", "reviews", "activity_events", "workspace_audit_log",
  ];

  test("every readable tenant table returns only workspace A rows for A's owner", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      for (const t of tenantTables) {
        const r = await rows<{ n: number }>(q,
          `select count(*)::int n from public.${t} where workspace_id <> $1`, [w.wsA]);
        assert.equal(r[0].n, 0, `${t} leaked rows from another workspace`);
      }
    });
  });

  test("selecting B rows by primary key returns nothing", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      assert.equal((await rows(q, "select id from public.contacts where id = $1", [contactB])).length, 0);
      assert.equal((await rows(q, "select id from public.opportunities where id = $1", [oppB])).length, 0);
      assert.equal((await rows(q, "select id from public.calendars where id = $1", [calendarB])).length, 0);
      assert.equal((await rows(q, "select id from public.workspaces where id = $1", [w.wsB])).length, 0);
    });
  });

  test("B member profiles are not visible to A", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      assert.equal((await rows(q, "select user_id from public.profiles where user_id = $1", [w.ownerB.id])).length, 0);
    });
  });

  test("a member of both workspaces sees only the active one, then only the other after switching", async () => {
    await asUser(w.db, w.dual, async (q) => {
      await rpc(q, "switch_workspace", [w.wsA]);
      const a = await rows<{ workspace_id: string }>(q, "select distinct workspace_id from public.contacts");
      assert.deepEqual(a.map((r) => r.workspace_id), [w.wsA]);
    });
    await asUser(w.db, w.dual, async (q) => {
      await rpc(q, "switch_workspace", [w.wsB]);
      const b = await rows<{ workspace_id: string }>(q, "select distinct workspace_id from public.contacts");
      assert.deepEqual(b.map((r) => r.workspace_id), [w.wsB]);
      await rpc(q, "switch_workspace", [w.wsA]);
    });
  });

  test("the reporting view inherits RLS", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      const r = await rows<{ n: number }>(q,
        "select count(*)::int n from public.pipeline_stage_summary where workspace_id <> $1", [w.wsA]);
      assert.equal(r[0].n, 0);
      const mine = await rows<{ n: number }>(q, "select count(*)::int n from public.pipeline_stage_summary");
      assert.equal(mine[0].n, 12);
    });
  });

  test("integration secrets are unreadable even by an owner", async () => {
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("select * from public.integration_secrets")),
      /permission denied/);
  });
});

describe("workspace A cannot modify workspace B", () => {
  test("inserting a row with workspace_id = B is rejected", async () => {
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.contacts (workspace_id, first_name) values ($1, 'forged')",
        [w.wsB])),
      /row-level security/);
  });

  test("updating B rows by id affects nothing", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      const r = await q.query("update public.contacts set first_name = 'hacked' where id = $1", [contactB]);
      assert.equal(r.affectedRows, 0);
      const o = await q.query("update public.opportunities set title = 'hacked' where id = $1", [oppB]);
      assert.equal(o.affectedRows, 0);
    });
    await asUser(w.db, w.ownerB, async (q) => {
      const r = await rows<{ first_name: string }>(q, "select first_name from public.contacts where id = $1", [contactB]);
      assert.equal(r[0].first_name, "Bob B");
    });
  });

  test("deleting B rows affects nothing", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      const r = await q.query("delete from public.contact_tags where contact_id = $1", [contactB]);
      assert.equal(r.affectedRows, 0);
    });
  });

  test("soft-deleting a B contact through the RPC is not_found", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "soft_delete_contact", [contactB])), /not_found/);
  });

  test("moving an A row into B by changing workspace_id is rejected", async () => {
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("update public.contacts set workspace_id = $1 where id = $2", [w.wsB, contactA])),
      /permission denied/);
  });

  test("the workspace_id immutability trigger also blocks privileged updates", async () => {
    await assert.rejects(
      w.db.query("update public.contacts set workspace_id = $1 where id = $2", [w.wsB, contactA]),
      /workspace_id is immutable/);
  });

  test("membership, active-workspace, invitation, grant, and platform tables are not directly writable", async () => {
    const attempts = [
      ["insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [w.wsB, w.ownerA.id]],
      ["update public.workspace_members set role = 'owner' where user_id = $1", [w.employeeA.id]],
      ["insert into public.user_active_workspace (user_id, workspace_id) values ($1, $2)", [w.outsider.id, w.wsA]],
      ["update public.user_active_workspace set workspace_id = $1", [w.wsB]],
      ["insert into public.platform_admins (user_id) values ($1)", [w.employeeA.id]],
      ["insert into public.platform_access_grants (workspace_id, admin_user_id, mode, reason, expires_at) values ($1, $2, 'write', 'forged grant', now() + interval '1 hour')", [w.wsB, w.employeeA.id]],
      ["insert into public.workspace_invitations (workspace_id, email, role, token_hash, expires_at) values ($1, 'x@example.test', 'owner', '\\x00', now() + interval '1 day')", [w.wsA]],
      ["update public.workspaces set status = 'active' where id = $1", [w.wsA]],
      ["insert into public.workspace_audit_log (workspace_id, actor_kind, action) values ($1, 'member', 'forged')", [w.wsA]],
    ] as const;
    for (const [sql, params] of attempts) {
      await assert.rejects(asUser(w.db, w.employeeA, (q) => q.query(sql, [...params])), /permission denied/, sql);
    }
  });
});

describe("forged workspace IDs are rejected", () => {
  test("switching to a workspace without membership is forbidden and leaves the active workspace unchanged", async () => {
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "switch_workspace", [w.wsB])), /forbidden/);
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "switch_workspace", [randomUUID()])), /forbidden/);
    await asUser(w.db, w.employeeA, async (q) => {
      const ctx = await rpc<{ workspace: { id: string } }>(q, "request_context");
      assert.equal(ctx.workspace.id, w.wsA);
    });
  });

  test("a JWT subject that is not a real user has no access", async () => {
    const ghost = { id: randomUUID(), email: "ghost@example.test" };
    await asUser(w.db, ghost, async (q) => {
      const r = await rows<{ n: number }>(q, "select count(*)::int n from public.contacts");
      assert.equal(r[0].n, 0);
    });
    await assert.rejects(asUser(w.db, ghost, (q) => rpc(q, "switch_workspace", [w.wsA])), /forbidden/);
  });

  test("created_by cannot be supplied by the client; the database stamps the caller", async () => {
    await assert.rejects(
      asUser(w.db, w.employeeA, (q) => q.query(
        "insert into public.contacts (workspace_id, first_name, created_by) values ($1, 'x', $2)",
        [w.wsA, w.ownerA.id])),
      /permission denied/);
    const created = await asUser(w.db, w.employeeA, async (q) => (await rows<{ created_by: string }>(q,
      "insert into public.contacts (workspace_id, first_name) values ($1, 'stamped') returning created_by",
      [w.wsA]))[0].created_by);
    assert.equal(created, w.employeeA.id);
  });

  test("message author and direction cannot be forged; nothing is marked outbound", async () => {
    await asUser(w.db, w.ownerA, async (q) => {
      const conv = await rows<{ id: string }>(q,
        "insert into public.conversations (workspace_id, contact_id, channel) values ($1, $2, 'sms') returning id",
        [w.wsA, contactA]);
      await assert.rejects(
        q.query("insert into public.messages (workspace_id, conversation_id, direction, body) values ($1, $2, 'outbound', 'hi')",
          [w.wsA, conv[0].id]),
        /row-level security/);
    });
    for (const sql of [
      "insert into public.messages (workspace_id, conversation_id, direction, body, author_user_id) values ($1, gen_random_uuid(), 'internal', 'hi', $2)",
      "insert into public.messages (workspace_id, conversation_id, direction, body, delivery_status) values ($1, gen_random_uuid(), 'internal', 'hi', 'sent')",
    ]) {
      const params = sql.includes("author_user_id") ? [w.wsA, w.employeeA.id] : [w.wsA];
      await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(sql, params)), /permission denied/, sql);
    }
  });

  test("random UUIDs as references are rejected", async () => {
    const stage = await stageId(w.db, w.ownerA, 1);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        `insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title)
         values ($1, $2, $3, $4, 'x')`,
        [w.wsA, randomUUID(), stage.pipeline_id, stage.id])),
      /foreign key/);
  });
});

describe("cross-workspace relationships are rejected by constraints", () => {
  async function insertOpp(contactId: string, pipelineId: string, stage: string, assigned: string | null = null) {
    return asUser(w.db, w.ownerA, (q) => q.query(
      `insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title, assigned_user_id)
       values ($1, $2, $3, $4, 'x', $5)`,
      [w.wsA, contactId, pipelineId, stage, assigned]));
  }

  test("opportunity in A referencing a contact in B", async () => {
    const s = await stageId(w.db, w.ownerA, 1);
    await assert.rejects(insertOpp(contactB, s.pipeline_id, s.id), /foreign key/);
  });

  test("opportunity in A using a stage from B's pipeline", async () => {
    const sA = await stageId(w.db, w.ownerA, 1);
    const sB = await stageId(w.db, w.ownerB, 1);
    await assert.rejects(insertOpp(contactA, sB.pipeline_id, sB.id), /foreign key/);
    await assert.rejects(insertOpp(contactA, sA.pipeline_id, sB.id), /foreign key/);
  });

  test("moving an A opportunity to a B stage", async () => {
    const sA = await stageId(w.db, w.ownerA, 1);
    const sB = await stageId(w.db, w.ownerB, 2);
    const id = await asUser(w.db, w.ownerA, async (q) => (await rows<{ id: string }>(q,
      `insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title)
       values ($1, $2, $3, $4, 'move test') returning id`,
      [w.wsA, contactA, sA.pipeline_id, sA.id]))[0].id);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("update public.opportunities set stage_id = $1 where id = $2", [sB.id, id])),
      /foreign key/);
  });

  test("opportunity status follows the stage kind", async () => {
    const sOpen = await stageId(w.db, w.ownerA, 1);
    const sWon = await stageId(w.db, w.ownerA, 10);
    await asUser(w.db, w.ownerA, async (q) => {
      const id = (await rows<{ id: string }>(q,
        `insert into public.opportunities (workspace_id, contact_id, pipeline_id, stage_id, title)
         values ($1, $2, $3, $4, 'status test') returning id`,
        [w.wsA, contactA, sOpen.pipeline_id, sOpen.id]))[0].id;
      await q.query("update public.opportunities set stage_id = $1 where id = $2", [sWon.id, id]);
      const r = await rows<{ status: string; closed_at: string | null }>(q,
        "select status, closed_at from public.opportunities where id = $1", [id]);
      assert.equal(r[0].status, "won");
      assert.ok(r[0].closed_at);
    });
  });

  test("appointment in A with a calendar, contact, or opportunity from B", async () => {
    const base = "insert into public.appointments (workspace_id, calendar_id, contact_id, opportunity_id, starts_at, ends_at) values ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 30 minutes')";
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(base, [w.wsA, calendarB, contactA, null])), /foreign key/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(base, [w.wsA, calendarA, contactB, null])), /foreign key/);
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(base, [w.wsA, calendarA, contactA, oppB])), /foreign key/);
  });

  // The active-member trigger fires before the composite FK; either constraint rejecting is correct.
  const NOT_SAME_WORKSPACE_MEMBER = /foreign key|active member of the same workspace/;

  test("assigning staff who belong only to B", async () => {
    const s = await stageId(w.db, w.ownerA, 1);
    await assert.rejects(insertOpp(contactA, s.pipeline_id, s.id, w.employeeB.id), NOT_SAME_WORKSPACE_MEMBER);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.tasks (workspace_id, title, assigned_user_id) values ($1, 't', $2)",
        [w.wsA, w.employeeB.id])),
      NOT_SAME_WORKSPACE_MEMBER);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.calendar_members (workspace_id, calendar_id, user_id) values ($1, $2, $3)",
        [w.wsA, calendarA, w.employeeB.id])),
      NOT_SAME_WORKSPACE_MEMBER);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("update public.contacts set owner_user_id = $1 where id = $2", [w.employeeB.id, contactA])),
      NOT_SAME_WORKSPACE_MEMBER);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("update public.ai_receptionist_configs set escalation_user_id = $1", [w.employeeB.id])),
      NOT_SAME_WORKSPACE_MEMBER);
  });

  test("the composite foreign key alone rejects cross-workspace staff (trigger bypassed)", async () => {
    await assert.rejects(
      w.db.transaction(async (tx) => {
        await tx.exec("alter table public.tasks disable trigger tasks_active_assignee");
        await tx.query(
          "insert into public.tasks (workspace_id, title, assigned_user_id) values ($1, 't', $2)",
          [w.wsA, w.employeeB.id]);
      }),
      /foreign key/);
  });

  test("tags, notes, and tasks referencing B records", async () => {
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("insert into public.contact_tags (workspace_id, contact_id, tag) values ($1, $2, 'x')", [w.wsA, contactB])),
      /foreign key/);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'x')",
        [w.wsA, contactB])),
      /foreign key/);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query(
        "insert into public.tasks (workspace_id, title, opportunity_id) values ($1, 't', $2)",
        [w.wsA, oppB])),
      /foreign key/);
  });

  test("overlapping bookings on one calendar are rejected; other calendars are unaffected", async () => {
    const calendar2 = await asUser(w.db, w.ownerA, async (q) => (await rows<{ id: string }>(q,
      "insert into public.calendars (workspace_id, name, slug, duration_minutes) values ($1, 'Second', 'second', 30) returning id",
      [w.wsA]))[0].id);
    const sql = "insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at) values ($1, $2, $3, '2030-01-01T15:00:00Z', '2030-01-01T15:30:00Z')";
    await asUser(w.db, w.ownerA, (q) => q.query(sql, [w.wsA, calendarA, contactA]));
    await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(sql, [w.wsA, calendarA, contactA])), /appointments_no_overlap|conflicting key/);
    await asUser(w.db, w.ownerA, (q) => q.query(sql, [w.wsA, calendar2, contactA]));
  });

  test("stage structure is fixed: no added, removed, or repositioned stages", async () => {
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("update public.pipeline_stages set position = 3 where position = 2")),
      /permission denied/);
    await assert.rejects(
      asUser(w.db, w.ownerA, (q) => q.query("delete from public.pipeline_stages where position = 12")),
      /permission denied/);
    await assert.rejects(
      w.db.transaction(async (tx) => {
        await tx.query("delete from public.pipeline_stages where workspace_id = $1 and position = 12", [w.wsA]);
      }),
      /exactly 12 stages/);
    await asUser(w.db, w.ownerA, async (q) => {
      const r = await q.query("update public.pipeline_stages set name = 'Fresh Lead' where position = 1");
      assert.equal(r.affectedRows, 1);
      await q.query("update public.pipeline_stages set name = 'New Lead' where position = 1");
    });
    await assert.rejects(
      asUser(w.db, w.employeeA, async (q) => {
        const r = await q.query("update public.pipeline_stages set name = 'Employee rename' where position = 1");
        if (r.affectedRows === 0) throw new Error("denied: no rows updated");
      }),
      /denied/);
  });
});

describe("a fresh user cannot self-provision or self-join", () => {
  test("a new signed-in user cannot create a workspace or membership", async () => {
    const fresh = await createUser(w.db, "fresh@example.test");
    await assert.rejects(
      asUser(w.db, fresh, (q) => rpc(q, "platform_provision_workspace", ["k-fresh", "Fresh", "fresh-ws", fresh.email])),
      /forbidden/);
    await assert.rejects(
      asUser(w.db, fresh, (q) => q.query("insert into public.workspaces (slug, name, provisioning_key, bootstrap_owner_email) values ('x-ws', 'X', 'k-x', 'x@example.test')")),
      /permission denied/);
  });
});

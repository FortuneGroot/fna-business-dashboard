import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  NestedSessionError, SESSION_TIMEOUT_MS, accept, adminCount, asAnon, asServiceRole, asUser, buildWorld,
  createContact, createUser, freshDb, invite, rows, rpc, stageId, type Db, type TestUser, type World,
} from "./harness";

// Regression tests for the eight findings from the P1 security review. Access assertions run as
// role `authenticated` / `anon` / `service_role` with JWT claims (the PostgREST path); the
// superuser connection is used only for fixtures and outcome checks.

const LEGACY_TABLES = [
  "auth_sessions", "sync_contacts", "sync_contact_tags", "sync_opportunities", "sync_appointments",
  "sync_conversation_events", "sync_tasks", "sync_review_events", "sync_events", "sync_idempotency",
];
const LOCKDOWN = "20261101001400_legacy_lockdown.sql";

describe("finding 1: legacy tables are preserved and locked to the service role", () => {
  let db: Db;
  let anonCouldReadBefore = false;

  before(async () => {
    db = await freshDb({
      beforeMigration: {
        [LOCKDOWN]: async (pre) => {
          await pre.query(
            "insert into public.sync_contacts (location_id, external_contact_id, first_name) values ('loc-test', 'ext-1', 'Legacy')");
          const c = await pre.query<{ id: string }>("select id from public.sync_contacts where external_contact_id = 'ext-1'");
          await pre.query("insert into public.sync_contact_tags (contact_id, tag) values ($1, 'legacy')", [c.rows[0].id]);
          await pre.query(
            "insert into public.auth_sessions (id, email, role, expires_at) values ('sess-1', 'legacy@example.test', 'OWNER', now() + interval '1 day')");
          await pre.query("insert into public.sync_idempotency (location_id, idempotency_key) values ('loc-test', 'k1')");
          anonCouldReadBefore = await asAnon(pre, async (q) => {
            const r = await rows<{ n: number }>(q, "select count(*)::int n from public.sync_contacts");
            return r[0].n === 1;
          });
        },
      },
    });
  });

  after(async () => {
    await db.close();
  });

  test("before the lockdown, the anon role could read legacy sync data (the reported exposure)", () => {
    assert.equal(anonCouldReadBefore, true);
  });

  test("rows written before the lockdown are preserved", async () => {
    assert.equal(await adminCount(db, "select count(*) n from public.sync_contacts where external_contact_id = 'ext-1'"), 1);
    assert.equal(await adminCount(db, "select count(*) n from public.sync_contact_tags where tag = 'legacy'"), 1);
    assert.equal(await adminCount(db, "select count(*) n from public.auth_sessions where id = 'sess-1'"), 1);
    assert.equal(await adminCount(db, "select count(*) n from public.sync_idempotency where idempotency_key = 'k1'"), 1);
  });

  test("every legacy table has RLS enabled with no policies", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean; policies: number }>(
      `select c.relname, c.relrowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1)`, [LEGACY_TABLES]);
    assert.equal(r.rows.length, LEGACY_TABLES.length);
    for (const row of r.rows) {
      assert.ok(row.relrowsecurity, `${row.relname} RLS disabled`);
      assert.equal(row.policies, 0, `${row.relname} has policies`);
    }
  });

  test("anon and authenticated hold no privileges on legacy tables", async () => {
    const r = await db.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      [LEGACY_TABLES]);
    assert.deepEqual(r.rows, []);
  });

  test("anon and signed-in users are refused on every legacy table", async () => {
    const user = await createUser(db, "legacy-probe@example.test");
    for (const t of LEGACY_TABLES) {
      await assert.rejects(asAnon(db, (q) => q.query(`select 1 from public.${t} limit 1`)), /permission denied/, t);
      await assert.rejects(asUser(db, user, (q) => q.query(`select 1 from public.${t} limit 1`)), /permission denied/, t);
    }
    await assert.rejects(
      asAnon(db, (q) => q.query("insert into public.sync_events (location_id, idempotency_key, event_type) values ('x', 'y', 'z')")),
      /permission denied/);
    await assert.rejects(
      asUser(db, user, (q) => q.query("update public.auth_sessions set revoked = true")),
      /permission denied/);
  });

  test("the service role keeps select, insert, update, and delete", async () => {
    await asServiceRole(db, async (q) => {
      assert.equal((await rows<{ n: number }>(q, "select count(*)::int n from public.sync_contacts"))[0].n, 1);
      await q.query("insert into public.sync_events (location_id, idempotency_key, event_type) values ('loc-test', 'k2', 'test')");
      const u = await q.query("update public.auth_sessions set revoked = true where id = 'sess-1'");
      assert.equal(u.affectedRows, 1);
      const d = await q.query("delete from public.sync_idempotency where idempotency_key = 'k1'");
      assert.equal(d.affectedRows, 1);
    });
  });

  test("the lockdown migration contains no data-changing statements", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", LOCKDOWN), "utf8")
      .replace(/--.*$/gm, "");
    assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from|update\s+public|insert\s+into|alter\s+table\s+\S+\s+(drop|alter|rename))\b/i);
  });
});

describe("findings 2-8 (shared synthetic world)", () => {
  let w: World;
  let contactA: string;

  before(async () => {
    w = await buildWorld();
    contactA = await createContact(w.db, w.ownerA, w.wsA, "Finding contact");
  });

  after(async () => {
    await w.db.close();
  });

  describe("finding 2: owner-affecting changes take the workspace lock before mutating", () => {
    async function fnDef(signature: string): Promise<string> {
      const r = await w.db.query<{ def: string }>("select pg_get_functiondef($1::regprocedure) def", [signature]);
      return r.rows[0].def.toLowerCase();
    }

    for (const sig of [
      "public.set_member_role(uuid, text)",
      "public.remove_member(uuid)",
      "public.leave_workspace()",
      "public.accept_invitation(text)",
      "public.platform_rotate_bootstrap_invitation(uuid, text)",
    ]) {
      test(`${sig} locks the workspace before its first write`, async () => {
        const def = await fnDef(sig);
        const lock = def.indexOf("private.lock_workspace_membership(");
        const firstWrite = def.search(/\b(insert into|update|delete from) public\.|private\.deactivate_member\(/);
        assert.ok(lock > 0, "lock call missing");
        assert.ok(firstWrite > 0, "no write found");
        assert.ok(lock < firstWrite, "lock must precede the first write");
      });
    }

    test("role changes, removal, and leaving re-check last-owner protection under the lock", async () => {
      for (const sig of ["public.set_member_role(uuid, text)", "public.remove_member(uuid)", "public.leave_workspace()"]) {
        const def = await fnDef(sig);
        const lock = def.indexOf("private.lock_workspace_membership(");
        const recheck = def.indexOf("private.assert_not_last_owner(");
        assert.ok(recheck > lock && lock > 0, `${sig} must re-check after locking`);
      }
      assert.match(await fnDef("private.guard_last_owner()"), /private\.lock_workspace_membership\(/);
      assert.match(await fnDef("private.lock_workspace_membership(uuid)"), /for no key update/);
    });

    test("sequentially, the second of two owners can never remove the last owner", async () => {
      const o1 = await createUser(w.db, "f2-owner1@example.test");
      const o2 = await createUser(w.db, "f2-owner2@example.test");
      const prov = await asUser(w.db, w.platform, (q) => rpc<{ workspace_id: string; invite_token: string }>(q,
        "platform_provision_workspace", ["synthetic-f2", "Finding 2 Fixture (synthetic)", "finding-2-fixture", o1.email]));
      await accept(w.db, o1, prov.invite_token);
      await accept(w.db, o2, await invite(w.db, o1, o2.email, "owner"));

      await asUser(w.db, o2, (q) => rpc(q, "remove_member", [o1.id]));
      await assert.rejects(asUser(w.db, o2, (q) => rpc(q, "leave_workspace")), /at least one active owner/);
      await assert.rejects(asUser(w.db, o2, (q) => rpc(q, "set_member_role", [o2.id, "admin"])), /forbidden/);
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_members where workspace_id = $1 and role = 'owner' and status = 'active'",
        [prov.workspace_id]), 1);
    });
  });

  describe("finding 3: nested PGlite sessions fail fast instead of deadlocking", () => {
    test("asUser inside asUser rejects immediately and the database stays usable", async () => {
      const started = Date.now();
      await asUser(w.db, w.ownerA, async () => {
        await assert.rejects(asUser(w.db, w.adminA, async () => 1), NestedSessionError);
        await assert.rejects(asAnon(w.db, async () => 1), NestedSessionError);
      });
      assert.ok(Date.now() - started < 2000, "nested call must fail fast");
      const n = await asUser(w.db, w.ownerA, async (q) =>
        (await rows<{ n: number }>(q, "select count(*)::int n from public.contacts"))[0].n);
      assert.ok(n >= 1);
    });

    test("superuser queries inside a session reject instead of deadlocking", async () => {
      await asUser(w.db, w.ownerA, async () => {
        await assert.rejects(w.db.query("select 1"), NestedSessionError);
        await assert.rejects(w.db.exec("select 1"), NestedSessionError);
        await assert.rejects(adminCount(w.db, "select 1 n"), NestedSessionError);
      });
    });

    test("sessions are bounded by a timeout and the test commands set --test-timeout", () => {
      assert.ok(SESSION_TIMEOUT_MS > 0 && SESSION_TIMEOUT_MS <= 30_000);
      const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
      assert.match(pkg.scripts.test, /scripts\/run-tests\.mjs/);
      assert.match(pkg.scripts["test:db"], /scripts\/run-tests\.mjs --suite db/);
      const runner = readFileSync(join(__dirname, "..", "..", "scripts", "run-tests.mjs"), "utf8");
      assert.match(runner, /--test-timeout=\$\{timeoutMs\}/);
      assert.match(runner, /db: \{[^}]*timeoutMs: \d+/s);
    });
  });

  describe("finding 4: audited, platform-only bootstrap invitation rotation", () => {
    let ws: string;
    let firstToken: string;
    let bootstrap: TestUser;

    before(async () => {
      bootstrap = await createUser(w.db, "f4-bootstrap@example.test");
      const prov = await asUser(w.db, w.platform, (q) => rpc<{ workspace_id: string; invite_token: string }>(q,
        "platform_provision_workspace", ["synthetic-f4", "Finding 4 Fixture (synthetic)", "finding-4-fixture", bootstrap.email]));
      ws = prov.workspace_id;
      firstToken = prov.invite_token;
    });

    test("only an AAL2 platform admin may rotate, with a reason", async () => {
      for (const u of [w.ownerA, w.adminA, w.outsider, bootstrap, { ...w.platform, aal: "aal1" as const }]) {
        await assert.rejects(
          asUser(w.db, u, (q) => rpc(q, "platform_rotate_bootstrap_invitation", [ws, "Owner lost the original link"])),
          /forbidden/);
      }
      await assert.rejects(asAnon(w.db, (q) => rpc(q, "platform_rotate_bootstrap_invitation", [ws, "Owner lost the original link"])),
        /permission denied/);
      await assert.rejects(
        asUser(w.db, w.platform, (q) => rpc(q, "platform_rotate_bootstrap_invitation", [ws, "short"])),
        /validation_failed/);
    });

    test("rotation revokes the previous token and issues a new one to the bootstrap email, audited", async () => {
      const res = await asUser(w.db, w.platform, (q) => rpc<{ invite_token: string; invitation_id: string; revoked_invitation_ids: string[] }>(q,
        "platform_rotate_bootstrap_invitation", [ws, "Owner lost the original link"]));
      assert.match(res.invite_token, /^[0-9a-f]{64}$/);
      assert.equal(res.revoked_invitation_ids.length, 1);

      const old = await asAnon(w.db, (q) => rpc<{ status: string }>(q, "peek_invitation", [firstToken]));
      assert.equal(old.status, "revoked");
      await assert.rejects(asUser(w.db, bootstrap, (q) => rpc(q, "accept_invitation", [firstToken])), /invitation_revoked/);

      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_invitations where workspace_id = $1 and role = 'owner' and accepted_at is null and revoked_at is null",
        [ws]), 1);
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_invitations where id = $1 and email = $2 and created_by = $3",
        [res.invitation_id, bootstrap.email, w.platform.id]), 1);
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.platform_audit_log where workspace_id = $1 and action = 'workspace.bootstrap_invitation_rotated' and actor_id = $2 and reason = 'Owner lost the original link'",
        [ws, w.platform.id]), 1);
      assert.equal(await adminCount(w.db,
        "select count(*) n from public.workspace_audit_log where workspace_id = $1 and action = 'platform.bootstrap_invitation_rotated' and actor_kind = 'platform_admin'",
        [ws]), 1);
    });

    test("a failed rotation leaves the current invitation untouched (transactional)", async () => {
      const before = await w.db.query<{ id: string }>(
        "select id from public.workspace_invitations where workspace_id = $1 and accepted_at is null and revoked_at is null", [ws]);
      await w.db.query("update public.workspaces set bootstrap_owner_email = 'not-an-email' where id = $1", [ws]);
      try {
        await assert.rejects(
          asUser(w.db, w.platform, (q) => rpc(q, "platform_rotate_bootstrap_invitation", [ws, "This rotation must fail"])),
          /check constraint|violates/);
      } finally {
        await w.db.query("update public.workspaces set bootstrap_owner_email = $2 where id = $1", [ws, bootstrap.email]);
      }
      const afterRows = await w.db.query<{ id: string }>(
        "select id from public.workspace_invitations where workspace_id = $1 and accepted_at is null and revoked_at is null", [ws]);
      assert.deepEqual(afterRows.rows, before.rows);
    });

    test("the newest token works, and rotation is refused forever once an owner has joined", async () => {
      const res = await asUser(w.db, w.platform, (q) => rpc<{ invite_token: string }>(q,
        "platform_rotate_bootstrap_invitation", [ws, "Second rotation before acceptance"]));
      await accept(w.db, bootstrap, res.invite_token);
      assert.equal(await adminCount(w.db, "select count(*) n from public.workspaces where id = $1 and owner_acquired_at is not null", [ws]), 1);
      await assert.rejects(
        asUser(w.db, w.platform, (q) => rpc(q, "platform_rotate_bootstrap_invitation", [ws, "Attempt after owner joined"])),
        /conflict/);
    });

    test("established workspaces cannot be rotated", async () => {
      await assert.rejects(
        asUser(w.db, w.platform, (q) => rpc(q, "platform_rotate_bootstrap_invitation", [w.wsA, "Attempt on established workspace"])),
        /conflict/);
    });
  });

  describe("finding 5: note and message authors are members or write-grant holders, with attribution", () => {
    let conversationA: string;

    before(async () => {
      conversationA = await asUser(w.db, w.ownerA, async (q) => (await rows<{ id: string }>(q,
        "insert into public.conversations (workspace_id, contact_id, channel) values ($1, $2, 'internal') returning id",
        [w.wsA, contactA]))[0].id);
    });

    test("a member authors as themselves with no grant attribution", async () => {
      const note = await asUser(w.db, w.employeeA, async (q) => (await rows<{ author_id: string; author_grant_id: string | null }>(q,
        "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'member note') returning author_id, author_grant_id",
        [w.wsA, contactA]))[0]);
      assert.deepEqual(note, { author_id: w.employeeA.id, author_grant_id: null });
    });

    test("a platform admin with a write grant can author notes and messages, attributed to the grant", async () => {
      const grant = await asUser(w.db, w.platform, (q) =>
        rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "write", "Adding support notes for the owner", 30]));
      const note = await asUser(w.db, w.platform, async (q) => (await rows<{ author_id: string; author_grant_id: string }>(q,
        "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'support note') returning author_id, author_grant_id",
        [w.wsA, contactA]))[0]);
      assert.deepEqual(note, { author_id: w.platform.id, author_grant_id: grant.id });
      const msg = await asUser(w.db, w.platform, async (q) => (await rows<{ author_user_id: string; author_grant_id: string }>(q,
        "insert into public.messages (workspace_id, conversation_id, direction, body) values ($1, $2, 'internal', 'support message') returning author_user_id, author_grant_id",
        [w.wsA, conversationA]))[0]);
      assert.deepEqual(msg, { author_user_id: w.platform.id, author_grant_id: grant.id });

      // Assignees still require workspace membership, even for a write-grant holder.
      await assert.rejects(
        asUser(w.db, w.platform, (q) => q.query(
          "insert into public.tasks (workspace_id, title, assigned_user_id) values ($1, 'self-assign', $2)", [w.wsA, w.platform.id])),
        /foreign key|active member of the same workspace/);
      await assert.rejects(
        asUser(w.db, w.platform, (q) => q.query("update public.contacts set owner_user_id = $1 where id = $2", [w.platform.id, contactA])),
        /foreign key|active member of the same workspace/);

      await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "Support session finished"]));
      await assert.rejects(
        asUser(w.db, w.platform, (q) => q.query(
          "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'after revoke')", [w.wsA, contactA])),
        /row-level security|must be an active member/);
    });

    test("a read grant, or no grant, cannot author", async () => {
      await assert.rejects(
        asUser(w.db, w.platform, (q) => q.query(
          "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'no grant')", [w.wsA, contactA])),
        /row-level security|must be an active member/);
      const grant = await asUser(w.db, w.platform, (q) =>
        rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "Reviewing notes read-only", 30]));
      await assert.rejects(
        asUser(w.db, w.platform, (q) => q.query(
          "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'read grant')", [w.wsA, contactA])),
        /row-level security|must be an active member/);
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "Support session finished"]));
    });

    test("removed members cannot author", async () => {
      const temp = await createUser(w.db, "f5-temp@example.test");
      await accept(w.db, temp, await invite(w.db, w.ownerA, temp.email, "employee"));
      await asUser(w.db, w.ownerA, (q) => rpc(q, "remove_member", [temp.id]));
      await assert.rejects(
        asUser(w.db, temp, (q) => q.query(
          "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'removed')", [w.wsA, contactA])),
        /row-level security|must be an active member/);
    });
  });

  describe("finding 6: actor attribution is database-controlled", () => {
    test("created_by cannot be supplied on any table and is stamped with the caller", async () => {
      const stage = await stageId(w.db, w.ownerA, 1);
      const calendar = await asUser(w.db, w.ownerA, async (q) => (await rows<{ id: string }>(q,
        "insert into public.calendars (workspace_id, name, slug, duration_minutes) values ($1, 'F6', 'f6', 30) returning id",
        [w.wsA]))[0].id);
      const cases: Array<{ table: string; cols: string; vals: string; params: unknown[] }> = [
        { table: "contacts", cols: "workspace_id, first_name", vals: "$1, 'f6'", params: [w.wsA] },
        { table: "opportunities", cols: "workspace_id, contact_id, pipeline_id, stage_id, title", vals: "$1, $2, $3, $4, 'f6'",
          params: [w.wsA, contactA, stage.pipeline_id, stage.id] },
        { table: "appointments", cols: "workspace_id, calendar_id, contact_id, starts_at, ends_at",
          vals: "$1, $2, $3, '2031-02-02T10:00:00Z', '2031-02-02T10:30:00Z'", params: [w.wsA, calendar, contactA] },
        { table: "tasks", cols: "workspace_id, title", vals: "$1, 'f6'", params: [w.wsA] },
      ];
      for (const c of cases) {
        const n = c.params.length + 1;
        await assert.rejects(
          asUser(w.db, w.employeeA, (q) => q.query(
            `insert into public.${c.table} (${c.cols}, created_by) values (${c.vals}, $${n})`, [...c.params, w.ownerA.id])),
          /permission denied/, `${c.table} accepted a client-supplied created_by`);
        const stamped = await asUser(w.db, w.employeeA, async (q) => (await rows<{ created_by: string }>(q,
          `insert into public.${c.table} (${c.cols}) values (${c.vals}) returning created_by`, c.params))[0].created_by);
        assert.equal(stamped, w.employeeA.id, `${c.table}.created_by not stamped`);
      }
    });

    test("created_by is immutable even for privileged updates", async () => {
      await w.db.query("update public.contacts set created_by = $1 where id = $2", [w.outsider.id, contactA]);
      assert.equal(await adminCount(w.db, "select count(*) n from public.contacts where id = $1 and created_by = $2", [contactA, w.ownerA.id]), 1);
    });

    test("updated_by is stamped on settings and AI configuration and cannot be supplied", async () => {
      await assert.rejects(
        asUser(w.db, w.adminA, (q) => q.query("update public.workspace_settings set updated_by = $1", [w.ownerA.id])),
        /permission denied/);
      await assert.rejects(
        asUser(w.db, w.adminA, (q) => q.query("update public.ai_receptionist_configs set updated_by = $1", [w.ownerA.id])),
        /permission denied/);
      await asUser(w.db, w.adminA, async (q) => {
        await q.query("update public.workspace_settings set industry = 'Towing (synthetic)'");
        await q.query("update public.ai_receptionist_configs set greeting = 'Hello (synthetic)'");
      });
      assert.equal(await adminCount(w.db, "select count(*) n from public.workspace_settings where workspace_id = $1 and updated_by = $2", [w.wsA, w.adminA.id]), 1);
      assert.equal(await adminCount(w.db, "select count(*) n from public.ai_receptionist_configs where workspace_id = $1 and updated_by = $2", [w.wsA, w.adminA.id]), 1);
    });

    test("note/message author and grant columns cannot be supplied by clients", async () => {
      for (const [sql, params] of [
        ["insert into public.contact_notes (workspace_id, contact_id, body, author_id) values ($1, $2, 'x', $3)", [w.wsA, contactA, w.ownerA.id]],
        ["insert into public.contact_notes (workspace_id, contact_id, body, author_grant_id) values ($1, $2, 'x', gen_random_uuid())", [w.wsA, contactA]],
        ["insert into public.integrations (workspace_id, provider, connected_by) values ($1, 'forged_by', $2)", [w.wsA, w.adminA.id]],
      ] as const) {
        await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(sql, [...params])), /permission denied/, sql);
      }
    });
  });

  describe("finding 7: audit and author grant references must be in the same workspace", () => {
    let grantA: string;

    before(async () => {
      grantA = (await asUser(w.db, w.platform, (q) =>
        rpc<{ id: string }>(q, "platform_grant_access", [w.wsA, "read", "Grant used for FK regression test", 30]))).id;
      await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grantA, "Support session finished"]));
    });

    test("composite foreign keys exist on (workspace_id, grant id)", async () => {
      const r = await w.db.query<{ conrelid: string; def: string }>(
        `select conrelid::regclass::text conrelid, pg_get_constraintdef(oid) def from pg_constraint
         where contype = 'f' and confrelid = 'public.platform_access_grants'::regclass`);
      const defs = r.rows.map((x) => `${x.conrelid}: ${x.def}`);
      for (const [table, col] of [["workspace_audit_log", "grant_id"], ["contact_notes", "author_grant_id"], ["messages", "author_grant_id"]]) {
        assert.ok(defs.some((d) => d === `${table}: FOREIGN KEY (workspace_id, ${col}) REFERENCES platform_access_grants(workspace_id, id)`),
          `${table} lacks composite FK; found ${JSON.stringify(defs)}`);
      }
      assert.ok(!defs.some((d) => /FOREIGN KEY \((grant_id|author_grant_id)\) REFERENCES/.test(d)), "single-column grant FK remains");
    });

    test("a workspace B audit row cannot reference a workspace A grant, even with privileges", async () => {
      await assert.rejects(
        w.db.query(
          "insert into public.workspace_audit_log (workspace_id, actor_kind, grant_id, action) values ($1, 'platform_admin', $2, 'forged')",
          [w.wsB, grantA]),
        /foreign key/);
      await w.db.query(
        "insert into public.workspace_audit_log (workspace_id, actor_kind, grant_id, action) values ($1, 'platform_admin', $2, 'fk-regression')",
        [w.wsA, grantA]);
    });

    test("a workspace B note cannot carry a workspace A grant attribution", async () => {
      const contactB = await createContact(w.db, w.ownerB, w.wsB, "F7 contact");
      await assert.rejects(
        w.db.query(
          "insert into public.contact_notes (workspace_id, contact_id, body, author_id, author_grant_id) values ($1, $2, 'x', $3, $4)",
          [w.wsB, contactB, w.platform.id, grantA]),
        /foreign key/);
    });
  });

  describe("finding 8: clients cannot verify integrations or enable the AI receptionist", () => {
    test("status, capabilities, and verified_at cannot be written by clients", async () => {
      for (const sql of [
        "insert into public.integrations (workspace_id, provider, status) values ($1, 'f8_a', 'connected')",
        "insert into public.integrations (workspace_id, provider, verified_at) values ($1, 'f8_b', now())",
        "insert into public.integrations (workspace_id, provider, capabilities) values ($1, 'f8_c', '{voice}')",
      ]) {
        await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(sql, [w.wsA])), /permission denied/, sql);
      }
      const row = await asUser(w.db, w.ownerA, async (q) => (await rows<{ id: string; status: string; verified_at: string | null; capabilities: string[]; connected_by: string }>(q,
        `insert into public.integrations (workspace_id, provider, config) values ($1, 'voice_provider', '{"capability":"voice","status":"connected"}')
         returning id, status, verified_at, capabilities, connected_by`, [w.wsA]))[0]);
      assert.equal(row.status, "disconnected");
      assert.equal(row.verified_at, null);
      assert.deepEqual(row.capabilities, []);
      assert.equal(row.connected_by, w.ownerA.id);
      for (const sql of [
        "update public.integrations set status = 'connected' where id = $1",
        "update public.integrations set verified_at = now() where id = $1",
        "update public.integrations set capabilities = '{voice}' where id = $1",
      ]) {
        await assert.rejects(asUser(w.db, w.ownerA, (q) => q.query(sql, [row.id])), /permission denied/, sql);
      }
    });

    test("connected requires verification even for the service role", async () => {
      await assert.rejects(
        asServiceRole(w.db, (q) => q.query("update public.integrations set status = 'connected' where workspace_id = $1 and provider = 'voice_provider'", [w.wsA])),
        /integrations_connected_requires_verification/);
    });

    test("a client config change clears server-side verification", async () => {
      await asServiceRole(w.db, (q) => q.query(
        "update public.integrations set status = 'connected', verified_at = now(), capabilities = '{voice}' where workspace_id = $1 and provider = 'voice_provider'",
        [w.wsA]));
      await asUser(w.db, w.ownerA, (q) => q.query(
        `update public.integrations set config = '{"capability":"voice","number":"+15550000000"}' where provider = 'voice_provider'`));
      const r = await w.db.query<{ status: string; verified_at: string | null; capabilities: string[] }>(
        "select status, verified_at, capabilities from public.integrations where workspace_id = $1 and provider = 'voice_provider'", [w.wsA]);
      assert.deepEqual(r.rows[0], { status: "disconnected", verified_at: null, capabilities: [] });
    });

    test("AI receptionist enablement is blocked for clients, the service role, and superusers", async () => {
      await asServiceRole(w.db, (q) => q.query(
        "update public.integrations set status = 'connected', verified_at = now(), capabilities = '{voice}' where workspace_id = $1 and provider = 'voice_provider'",
        [w.wsA]));
      await assert.rejects(
        asUser(w.db, w.ownerA, (q) => q.query("update public.ai_receptionist_configs set enabled = true")),
        /permission denied/);
      await assert.rejects(
        asServiceRole(w.db, (q) => q.query("update public.ai_receptionist_configs set enabled = true where workspace_id = $1", [w.wsA])),
        /ai_receptionist_disabled_until_runtime/);
      await assert.rejects(
        w.db.query("update public.ai_receptionist_configs set enabled = true where workspace_id = $1", [w.wsA]),
        /ai_receptionist_disabled_until_runtime/);
      assert.equal(await adminCount(w.db, "select count(*) n from public.ai_receptionist_configs where enabled"), 0);
    });
  });
});

describe("architecture guard: workspaces only", () => {
  test("no migration defines organizations tables or organization_id columns", () => {
    const dir = join(__dirname, "..", "..", "supabase", "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8");
      assert.doesNotMatch(sql, /\borganizations?\b|\borganization_id\b|\borg_id\b/i, f);
    }
  });
});

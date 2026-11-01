import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { beginAs, requestAs, startRealPostgres, type RealPg, type RealUser } from "./realpg";

// Finding 2: owner-affecting membership changes must serialize on the workspace lock, so two
// concurrent requests can never leave a workspace without an active owner. Requires independent
// PostgreSQL sessions (one pg.Client each) on a real local server.

let server: RealPg;
let admin: pg.Client;
let platform: RealUser;
let seq = 0;

const LAST_OWNER = /at least one active owner|forbidden/;

async function createUser(email: string, aal: "aal1" | "aal2" = "aal1"): Promise<RealUser> {
  const r = await admin.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email]);
  return { id: r.rows[0].id, email, aal };
}

/** Provisions a fresh synthetic workspace with two active owners and one employee. */
async function twoOwnerWorkspace() {
  seq += 1;
  const owner1 = await createUser(`race-owner1-${seq}@example.test`);
  const owner2 = await createUser(`race-owner2-${seq}@example.test`);
  const employee = await createUser(`race-employee-${seq}@example.test`);
  const c = await server.connect();
  try {
    const [prov] = await requestAs<{ r: { workspace_id: string; invite_token: string } }>(c, platform,
      "select public.platform_provision_workspace($1, $2, $3, $4) r",
      [`synthetic-race-${seq}`, `Race Fixture ${seq} (synthetic)`, `race-fixture-${seq}`, owner1.email]);
    const ws = prov.r.workspace_id;
    await requestAs(c, owner1, "select public.accept_invitation($1)", [prov.r.invite_token]);
    for (const [u, role] of [[owner2, "owner"], [employee, "employee"]] as const) {
      const [inv] = await requestAs<{ r: { token: string } }>(c, owner1,
        "select public.create_invitation($1, $2, 72) r", [u.email, role]);
      await requestAs(c, u, "select public.accept_invitation($1)", [inv.r.token]);
    }
    return { ws, owner1, owner2, employee };
  } finally {
    await c.end();
  }
}

async function activeOwners(ws: string): Promise<number> {
  const r = await admin.query<{ n: number }>(
    "select count(*)::int n from public.workspace_members where workspace_id = $1 and role = 'owner' and status = 'active'", [ws]);
  return r.rows[0].n;
}

async function roleOf(ws: string, userId: string): Promise<string> {
  const r = await admin.query<{ role: string }>(
    "select role from public.workspace_members where workspace_id = $1 and user_id = $2 and status = 'active'", [ws, userId]);
  return r.rows[0]?.role ?? "none";
}

async function overrides(ws: string, userId: string): Promise<number> {
  const r = await admin.query<{ n: number }>(
    "select count(*)::int n from public.member_permission_overrides where workspace_id = $1 and user_id = $2", [ws, userId]);
  return r.rows[0].n;
}

/** Provisions a workspace whose bootstrap owner invitation has not been accepted. */
async function unclaimedWorkspace() {
  seq += 1;
  const owner = await createUser(`unclaimed-owner-${seq}@example.test`);
  const c = await server.connect();
  try {
    const [prov] = await requestAs<{ r: { workspace_id: string; invite_token: string; invitation_id: string } }>(c, platform,
      "select public.platform_provision_workspace($1, $2, $3, $4) r",
      [`synthetic-unclaimed-${seq}`, `Unclaimed ${seq} (synthetic)`, `unclaimed-${seq}`, owner.email]);
    return { ws: prov.r.workspace_id, token: prov.r.invite_token, invitationId: prov.r.invitation_id, owner };
  } finally {
    await c.end();
  }
}

async function openOwnerInvitations(ws: string): Promise<number> {
  const r = await admin.query<{ n: number }>(
    `select count(*)::int n from public.workspace_invitations
     where workspace_id = $1 and role = 'owner' and accepted_at is null and revoked_at is null`, [ws]);
  return r.rows[0].n;
}

async function membersOf(ws: string): Promise<number> {
  const r = await admin.query<{ n: number }>(
    "select count(*)::int n from public.workspace_members where workspace_id = $1 and status = 'active'", [ws]);
  return r.rows[0].n;
}

/** One complete request in a fresh session; returns the RPC result or the error. */
async function attempt<T>(user: RealUser, sql: string, params: unknown[] = []) {
  const c = await server.connect();
  try {
    return await settle(requestAs<{ r: T }>(c, user, sql, params).then((rows) => rows[0]?.r));
  } finally {
    await c.end();
  }
}

const errorOf = (o: { ok: boolean }) => (o as unknown as { error?: Error }).error?.message ?? "";
const valueOf = <T>(o: { ok: boolean }) => (o as unknown as { value: pg.QueryResult }).value.rows[0].r as T;

async function waitingOnLock(): Promise<number> {
  const r = await admin.query<{ n: number }>(
    "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
  return r.rows[0].n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settles a promise into a tagged result without throwing. */
function settle<T>(p: Promise<T>) {
  return p.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));
}

/**
 * Runs `first` and `second` in two independent sessions. `first` executes and holds its
 * transaction open; `second` is started and must block on the workspace lock; then `first`
 * commits and `second` completes. Returns the outcome of `second`.
 */
async function race(
  first: { user: RealUser; sql: string; params: unknown[] },
  second: { user: RealUser; sql: string; params: unknown[] }
) {
  const a = await server.connect();
  const b = await server.connect();
  try {
    await beginAs(a, first.user);
    const firstResult = await a.query(first.sql, first.params);

    await beginAs(b, second.user);
    const pending = settle(b.query(second.sql, second.params));
    await sleep(400);
    const blocked = await waitingOnLock();
    const raced = await Promise.race([pending.then(() => "settled"), sleep(50).then(() => "pending")]);

    await a.query("commit");
    const outcome = await pending;
    await b.query(outcome.ok ? "commit" : "rollback");
    return { blocked, raced, outcome, first: firstResult.rows[0]?.r };
  } finally {
    await a.end();
    await b.end();
  }
}

before(async () => {
  server = await startRealPostgres();
  admin = await server.connect();
  platform = await createUser("race-platform@example.test", "aal2");
  await admin.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
});

after(async () => {
  await admin?.end().catch(() => {});
  await server?.stop();
});

describe("real PostgreSQL: concurrent owner changes serialize on the workspace lock", () => {
  test("server is real PostgreSQL with independent sessions", async () => {
    const a = await server.connect();
    const b = await server.connect();
    const [pa, pb] = await Promise.all([
      a.query<{ pid: number }>("select pg_backend_pid() pid"),
      b.query<{ pid: number }>("select pg_backend_pid() pid"),
    ]);
    assert.notEqual(pa.rows[0].pid, pb.rows[0].pid);
    await a.end();
    await b.end();
  });

  test("two owners leaving at the same time: the second blocks, then is refused", async () => {
    const { ws, owner1, owner2 } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.leave_workspace()", params: [] },
      { user: owner2, sql: "select public.leave_workspace()", params: [] });
    assert.equal(r.raced, "pending", "second leave must wait for the first transaction");
    assert.ok(r.blocked >= 1, "second leave must be waiting on a lock");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, /at least one active owner/);
    assert.equal(await activeOwners(ws), 1);
  });

  test("two owners removing each other at the same time leaves exactly one owner", async () => {
    const { ws, owner1, owner2 } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.remove_member($1)", params: [owner2.id] },
      { user: owner2, sql: "select public.remove_member($1)", params: [owner1.id] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, LAST_OWNER);
    assert.equal(await activeOwners(ws), 1);
  });

  test("two owners demoting each other at the same time leaves exactly one owner", async () => {
    const { ws, owner1, owner2 } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.set_member_role($1, 'admin')", params: [owner2.id] },
      { user: owner2, sql: "select public.set_member_role($1, 'admin')", params: [owner1.id] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, LAST_OWNER);
    assert.equal(await activeOwners(ws), 1);
  });

  test("an owner leaving while the other owner is being removed leaves exactly one owner", async () => {
    const { ws, owner1, owner2 } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.remove_member($1)", params: [owner2.id] },
      { user: owner1, sql: "select public.leave_workspace()", params: [] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, /at least one active owner/);
    assert.equal(await activeOwners(ws), 1);
  });

  test("control: with the lock disabled the same race leaves the workspace with no owner", async () => {
    const original = (await admin.query<{ def: string }>(
      "select pg_get_functiondef('private.lock_workspace_membership(uuid)'::regprocedure) def")).rows[0].def;
    await admin.query(`create or replace function private.lock_workspace_membership(p_workspace_id uuid)
      returns void language plpgsql security definer set search_path = '' as $$ begin end; $$`);
    try {
      const { ws, owner1, owner2 } = await twoOwnerWorkspace();
      const r = await race(
        { user: owner1, sql: "select public.leave_workspace()", params: [] },
        { user: owner2, sql: "select public.leave_workspace()", params: [] });
      assert.equal(r.outcome.ok, true, "without the lock the second leave is not refused");
      assert.equal(await activeOwners(ws), 0, "without the lock both owners leave");
    } finally {
      await admin.query(original);
    }
    const restored = (await admin.query<{ def: string }>(
      "select pg_get_functiondef('private.lock_workspace_membership(uuid)'::regprocedure) def")).rows[0].def;
    assert.match(restored, /for no key update/);
  });

  test("review 2: an owner demoted while waiting for the lock cannot promote someone to owner", async () => {
    const { ws, owner1, owner2, employee } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.set_member_role($1, 'admin')", params: [owner2.id] },
      { user: owner2, sql: "select public.set_member_role($1, 'owner')", params: [employee.id] });
    assert.equal(r.raced, "pending", "the promotion must wait for the demotion");
    assert.ok(r.blocked >= 1, "the promotion must be waiting on the workspace lock");
    assert.equal(r.outcome.ok, false, "stale owner authority must not be honoured");
    assert.match((r.outcome as { error: Error }).error.message, /forbidden/);
    assert.equal(await roleOf(ws, owner2.id), "admin");
    assert.equal(await roleOf(ws, employee.id), "employee");
    assert.equal(await activeOwners(ws), 1);
  });

  test("review 2 control: without the post-lock re-check the same race promotes with stale authority", async () => {
    const sig = "public.set_member_role(uuid, text)";
    const original = (await admin.query<{ def: string }>("select pg_get_functiondef($1::regprocedure) def", [sig])).rows[0].def;
    const recheck = "perform private.recheck_authority(v_ws, 'team.change_role', true);";
    assert.ok(original.includes(recheck));
    await admin.query(original.replace(recheck, ""));
    try {
      const { ws, owner1, owner2, employee } = await twoOwnerWorkspace();
      const r = await race(
        { user: owner1, sql: "select public.set_member_role($1, 'admin')", params: [owner2.id] },
        { user: owner2, sql: "select public.set_member_role($1, 'owner')", params: [employee.id] });
      assert.equal(r.raced, "pending");
      assert.equal(r.outcome.ok, true, "pre-lock checks alone accept the stale caller");
      assert.equal(await roleOf(ws, owner2.id), "admin");
      assert.equal(await roleOf(ws, employee.id), "owner", "the demoted caller promoted someone to owner");
    } finally {
      await admin.query(original);
    }
    const restored = (await admin.query<{ def: string }>("select pg_get_functiondef($1::regprocedure) def", [sig])).rows[0].def;
    assert.ok(restored.includes(recheck));
  });

  test("review 2: an owner removed while waiting for the lock cannot create an invitation", async () => {
    const { ws, owner1, owner2 } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.remove_member($1)", params: [owner2.id] },
      { user: owner2, sql: "select public.create_invitation($1, 'owner', 72)", params: [`race-late-invite-${seq}@example.test`] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, /forbidden/);
    const invites = await admin.query<{ n: number }>(
      "select count(*)::int n from public.workspace_invitations where workspace_id = $1 and created_by = $2", [ws, owner2.id]);
    assert.equal(invites.rows[0].n, 0);
  });

  test("an owner demoted to employee while waiting cannot set a permission override", async () => {
    const { ws, owner1, owner2, employee } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.set_member_role($1, 'employee')", params: [owner2.id] },
      { user: owner2, sql: "select public.set_member_permission($1, 'contacts.delete', true)", params: [employee.id] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, /forbidden/);
    assert.equal(await overrides(ws, employee.id), 0);
  });

  test("an override racing a promotion never survives on a non-employee (promotion first)", async () => {
    const { ws, owner1, owner2, employee } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner1, sql: "select public.set_member_role($1, 'admin')", params: [employee.id] },
      { user: owner2, sql: "select public.set_member_permission($1, 'contacts.delete', true)", params: [employee.id] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match((r.outcome as { error: Error }).error.message, /employees only/);
    assert.equal(await roleOf(ws, employee.id), "admin");
    assert.equal(await overrides(ws, employee.id), 0);
  });

  test("an override racing a promotion never survives on a non-employee (override first)", async () => {
    const { ws, owner1, owner2, employee } = await twoOwnerWorkspace();
    const r = await race(
      { user: owner2, sql: "select public.set_member_permission($1, 'contacts.delete', true)", params: [employee.id] },
      { user: owner1, sql: "select public.set_member_role($1, 'admin')", params: [employee.id] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, true);
    assert.equal(await roleOf(ws, employee.id), "admin");
    assert.equal(await overrides(ws, employee.id), 0, "promotion must clear the override committed just before it");
  });

  test("holding the membership lock does not block ordinary writes in the same workspace", async () => {
    const { ws, owner1, owner2, employee } = await twoOwnerWorkspace();
    const a = await server.connect();
    const e = await server.connect();
    try {
      await beginAs(a, owner1);
      await a.query("select public.set_member_role($1, 'admin')", [owner2.id]);
      const insert = requestAs(e, employee,
        "insert into public.contacts (workspace_id, first_name) values ($1, 'during lock') returning id", [ws]);
      const done = await Promise.race([insert.then(() => "done"), sleep(3000).then(() => "blocked")]);
      assert.equal(done, "done", "contact insert must not wait for the membership lock");
      await a.query("commit");
    } finally {
      await a.end();
      await e.end();
    }
  });
});

describe("real PostgreSQL: concurrent provisioning", () => {
  const PROVISION = "select public.platform_provision_workspace($1, $2, $3, $4) r";

  test("the same key and inputs from two sessions create one workspace; the replay reveals no token", async () => {
    const key = `synthetic-concurrent-${++seq}`;
    const args = [key, `Concurrent ${seq} (synthetic)`, `concurrent-${seq}`, `concurrent-owner-${seq}@example.test`];
    const r = await race({ user: platform, sql: PROVISION, params: args }, { user: platform, sql: PROVISION, params: args });
    assert.equal(r.raced, "pending", "the second provisioning must wait for the first");
    assert.ok(r.blocked >= 1);
    assert.equal(r.outcome.ok, true, errorOf(r.outcome));
    const first = r.first as { workspace_id: string; created: boolean; invite_token: string };
    const second = valueOf<{ workspace_id: string; created: boolean; invite_token: string | null }>(r.outcome);
    assert.equal(first.created, true);
    assert.match(first.invite_token, /^[0-9a-f]{64}$/);
    assert.equal(second.created, false);
    assert.equal(second.workspace_id, first.workspace_id);
    assert.equal(second.invite_token, null);
    const counts = await admin.query<{ ws: number; stages: number; invites: number }>(
      `select (select count(*)::int from public.workspaces where provisioning_key = $1) ws,
              (select count(*)::int from public.pipeline_stages where workspace_id = $2) stages,
              (select count(*)::int from public.workspace_invitations where workspace_id = $2) invites`, [key, first.workspace_id]);
    assert.deepEqual(counts.rows[0], { ws: 1, stages: 12, invites: 1 });
  });

  test("the same key with different inputs: the waiting session gets a conflict and changes nothing", async () => {
    const key = `synthetic-concurrent-${++seq}`;
    const r = await race(
      { user: platform, sql: PROVISION, params: [key, `First ${seq} (synthetic)`, `first-${seq}`, `first-${seq}@example.test`] },
      { user: platform, sql: PROVISION, params: [key, `Second ${seq} (synthetic)`, `first-${seq}`, `first-${seq}@example.test`] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /conflict/);
    const ws = await admin.query<{ name: string }>("select name from public.workspaces where provisioning_key = $1", [key]);
    assert.deepEqual(ws.rows.map((x) => x.name), [`First ${seq} (synthetic)`]);
  });

  test("different keys claiming the same slug: the waiting session gets a conflict and leaves no partial workspace", async () => {
    seq += 1;
    const slug = `contested-${seq}`;
    const r = await race(
      { user: platform, sql: PROVISION, params: [`synthetic-slug-a-${seq}`, `Slug A ${seq}`, slug, `slug-a-${seq}@example.test`] },
      { user: platform, sql: PROVISION, params: [`synthetic-slug-b-${seq}`, `Slug B ${seq}`, slug, `slug-b-${seq}@example.test`] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /conflict/);
    const ws = await admin.query<{ provisioning_key: string }>("select provisioning_key from public.workspaces where slug = $1", [slug]);
    assert.deepEqual(ws.rows.map((x) => x.provisioning_key), [`synthetic-slug-a-${seq}`]);
    const orphans = await admin.query<{ n: number }>(
      "select count(*)::int n from public.workspaces where provisioning_key = $1", [`synthetic-slug-b-${seq}`]);
    assert.equal(orphans.rows[0].n, 0);
  });
});

describe("real PostgreSQL: concurrent invitation acceptance, revocation, and rotation", () => {
  const ACCEPT = "select public.accept_invitation($1) r";

  async function invitee(owner: RealUser, role = "employee") {
    seq += 1;
    const u = await createUser(`invitee-${seq}@example.test`);
    const c = await server.connect();
    try {
      const [inv] = await requestAs<{ r: { token: string; invitation_id: string } }>(c, owner,
        "select public.create_invitation($1, $2, 72) r", [u.email, role]);
      return { user: u, token: inv.r.token, invitationId: inv.r.invitation_id };
    } finally {
      await c.end();
    }
  }

  test("the same invitation accepted from two sessions: one membership, the other gets invitation_used", async () => {
    const { ws, owner1 } = await twoOwnerWorkspace();
    const inv = await invitee(owner1);
    const r = await race({ user: inv.user, sql: ACCEPT, params: [inv.token] }, { user: inv.user, sql: ACCEPT, params: [inv.token] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /invitation_used/);
    assert.equal(await roleOf(ws, inv.user.id), "employee");
    const audits = await admin.query<{ n: number }>(
      "select count(*)::int n from public.workspace_audit_log where workspace_id = $1 and action = 'invitation.accepted' and target = $2",
      [ws, inv.invitationId]);
    assert.equal(audits.rows[0].n, 1);
  });

  test("two different invitees accepting at the same time both join", async () => {
    const { ws, owner1 } = await twoOwnerWorkspace();
    const before = await membersOf(ws);
    const a = await invitee(owner1);
    const b = await invitee(owner1, "admin");
    const r = await race({ user: a.user, sql: ACCEPT, params: [a.token] }, { user: b.user, sql: ACCEPT, params: [b.token] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, true, errorOf(r.outcome));
    assert.equal(await roleOf(ws, a.user.id), "employee");
    assert.equal(await roleOf(ws, b.user.id), "admin");
    assert.equal(await membersOf(ws), before + 2);
  });

  test("revocation first: the waiting acceptance is refused as revoked", async () => {
    const { ws, owner1 } = await twoOwnerWorkspace();
    const inv = await invitee(owner1);
    const r = await race(
      { user: owner1, sql: "select public.revoke_invitation($1)", params: [inv.invitationId] },
      { user: inv.user, sql: ACCEPT, params: [inv.token] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /invitation_revoked/);
    assert.equal(await roleOf(ws, inv.user.id), "none");
  });

  test("acceptance first: the waiting revocation is refused and the membership stands", async () => {
    const { ws, owner1 } = await twoOwnerWorkspace();
    const inv = await invitee(owner1);
    const r = await race(
      { user: inv.user, sql: ACCEPT, params: [inv.token] },
      { user: owner1, sql: "select public.revoke_invitation($1)", params: [inv.invitationId] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /conflict/);
    assert.equal(await roleOf(ws, inv.user.id), "employee");
  });

  const ROTATE = "select public.platform_rotate_bootstrap_invitation($1, 'lost bootstrap token (concurrency test)') r";

  test("rotation first: the old bootstrap token is refused; only the new token works", async () => {
    const { ws, token, owner } = await unclaimedWorkspace();
    const r = await race({ user: platform, sql: ROTATE, params: [ws] }, { user: owner, sql: ACCEPT, params: [token] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /invitation_revoked/);
    assert.equal(await roleOf(ws, owner.id), "none");
    const fresh = (r.first as { invite_token: string }).invite_token;
    const ok = await attempt(owner, ACCEPT, [fresh]);
    assert.equal(ok.ok, true, errorOf(ok));
    assert.equal(await roleOf(ws, owner.id), "owner");
    assert.equal(await openOwnerInvitations(ws), 0);
  });

  test("acceptance first: the waiting rotation is refused and issues no new invitation", async () => {
    const { ws, token, owner } = await unclaimedWorkspace();
    const r = await race({ user: owner, sql: ACCEPT, params: [token] }, { user: platform, sql: ROTATE, params: [ws] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, false);
    assert.match(errorOf(r.outcome), /conflict/);
    assert.equal(await roleOf(ws, owner.id), "owner");
    const total = await admin.query<{ n: number }>("select count(*)::int n from public.workspace_invitations where workspace_id = $1", [ws]);
    assert.equal(total.rows[0].n, 1);
  });

  test("two concurrent rotations leave exactly one open owner invitation, and only the last token works", async () => {
    const { ws, token, owner } = await unclaimedWorkspace();
    const r = await race({ user: platform, sql: ROTATE, params: [ws] }, { user: platform, sql: ROTATE, params: [ws] });
    assert.equal(r.raced, "pending");
    assert.equal(r.outcome.ok, true, errorOf(r.outcome));
    assert.equal(await openOwnerInvitations(ws), 1);
    const firstToken = (r.first as { invite_token: string }).invite_token;
    const lastToken = valueOf<{ invite_token: string; revoked_invitation_ids: string[] }>(r.outcome).invite_token;
    for (const stale of [token, firstToken]) {
      const refused = await attempt(owner, ACCEPT, [stale]);
      assert.match(errorOf(refused), /invitation_revoked/);
    }
    const ok = await attempt(owner, ACCEPT, [lastToken]);
    assert.equal(ok.ok, true, errorOf(ok));
    assert.equal(await roleOf(ws, owner.id), "owner");
  });
});

describe("real PostgreSQL: platform grants expire by the clock", () => {
  test("a one-minute write grant ends reads, writes, Storage reads, and context at expiry with no intervention", async () => {
    const { ws, owner1 } = await twoOwnerWorkspace();
    const c = await server.connect();
    try {
      await requestAs(c, owner1, "insert into public.contacts (workspace_id, first_name) values ($1, 'Expiry fixture')", [ws]);
      await requestAs(c, owner1, "insert into storage.objects (bucket_id, name, owner_id) values ('workspace-assets', $1, auth.uid()::text)",
        [`${ws}/owner-logo.png`]);

      const [g] = await requestAs<{ r: { id: string; expires_at: string } }>(c, platform,
        "select public.platform_grant_access($1, 'write', 'clock expiry regression', 1) r", [ws]);
      const grantId = g.r.id;
      const before = (await admin.query("select created_at, expires_at, revoked_at from public.platform_access_grants where id = $1", [grantId])).rows[0];

      const granted = `${ws}/owner-logo.png`;
      const [contact] = await requestAs<{ id: string }>(c, platform,
        "insert into public.contacts (workspace_id, first_name) values ($1, 'Before expiry') returning id", [ws]);
      const [seen] = await requestAs<{ n: number }>(c, platform, "select count(*)::int n from public.contacts");
      assert.equal(seen.n, 2);
      const [assetsLive] = await requestAs<{ n: number }>(c, platform,
        "select count(*)::int n from storage.objects where bucket_id = 'workspace-assets' and name = $1", [granted]);
      assert.equal(assetsLive.n, 1, "a live grant reads workspace assets");
      await assert.rejects(requestAs(c, platform,
        "insert into storage.objects (bucket_id, name, owner_id) values ('workspace-assets', $1, auth.uid()::text)",
        [`${ws}/granted.png`]), /row-level security/, "a write grant alone must not upload");
      assert.equal((await requestAs(c, platform,
        "update storage.objects set metadata = '{\"v\":2}' where name = $1 returning id", [granted])).length, 0);

      // Wait on the database clock, not the test clock; nothing touches the grant row.
      const deadline = Date.now() + 120_000;
      for (;;) {
        const r = await admin.query<{ expired: boolean }>("select now() > $1::timestamptz + interval '1 second' expired", [before.expires_at]);
        if (r.rows[0].expired) break;
        if (Date.now() > deadline) throw new Error("grant did not reach its expiry time");
        await sleep(2000);
      }

      const [after] = await requestAs<{ n: number }>(c, platform, "select count(*)::int n from public.contacts");
      assert.equal(after.n, 0, "expired grant still reads contacts");
      await assert.rejects(requestAs(c, platform,
        "insert into public.contacts (workspace_id, first_name) values ($1, 'After expiry')", [ws]), /row-level security/);
      const updated = await requestAs(c, platform, "update public.contacts set first_name = 'x' where id = $1 returning id", [contact.id]);
      assert.equal(updated.length, 0);
      const [assets] = await requestAs<{ n: number }>(c, platform,
        "select count(*)::int n from storage.objects where bucket_id = 'workspace-assets' and name like $1", [`${ws}/%`]);
      assert.equal(assets.n, 0, "expired grant still reads assets");
      assert.equal((await requestAs(c, platform,
        "update storage.objects set metadata = '{\"v\":3}' where name = $1 returning id", [granted])).length, 0);
      assert.equal((await requestAs(c, platform, "delete from storage.objects where name = $1 returning id", [granted])).length, 0);
      await assert.rejects(requestAs(c, platform,
        "insert into storage.objects (bucket_id, name, owner_id) values ('workspace-assets', $1, auth.uid()::text)",
        [`${ws}/after-expiry.png`]), /row-level security/);
      const [ctx] = await requestAs<{ r: { workspace: unknown; grant: unknown } }>(c, platform, "select public.request_context() r");
      assert.equal(ctx.r.grant, null);
      assert.equal(ctx.r.workspace, null);
      await assert.rejects(requestAs(c, platform, "select public.switch_workspace($1)", [ws]), /forbidden/);

      const row = (await admin.query("select created_at, expires_at, revoked_at from public.platform_access_grants where id = $1", [grantId])).rows[0];
      assert.deepEqual(row, before, "the grant row must be untouched; expiry is purely time-based");
      assert.equal(row.revoked_at, null);

      const audit = await admin.query<{ action: string; target: string | null }>(
        "select action, target from public.workspace_audit_log where workspace_id = $1 and grant_id = $2 order by id", [ws, grantId]);
      assert.deepEqual(audit.rows, [
        { action: "platform.access_granted", target: null },
        { action: "contacts.insert", target: contact.id },
      ]);
      const objects = await admin.query<{ n: number }>("select count(*)::int n from storage.objects where name = $1", [granted]);
      assert.equal(objects.rows[0].n, 1);
    } finally {
      await c.end();
    }
  });
});

describe("real PostgreSQL: platform Storage operations and their recovery never race", () => {
  const FINISHED = "select public.platform_storage_change_finished($1, $2, false) r";
  const UPSERT = `insert into storage.objects (bucket_id, name, user_metadata, version)
    values ('workspace-assets', $1, $2, gen_random_uuid()::text)
    on conflict (bucket_id, name) do update set user_metadata = excluded.user_metadata, version = excluded.version`;
  const MEMBER_UPSERT = `insert into storage.objects (bucket_id, name, owner_id, user_metadata, version)
    values ('workspace-assets', $1, auth.uid()::text, $2, gen_random_uuid()::text)
    on conflict (bucket_id, name) do update set user_metadata = excluded.user_metadata, version = excluded.version`;

  async function beginAsService(client: pg.Client) {
    await client.query("begin");
    await client.query("set local role service_role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  }

  /** A claimed platform upsert of the workspace logo whose lease has already expired. */
  async function claimedUpsert() {
    const { ws, owner1 } = await twoOwnerWorkspace();
    const c = await server.connect();
    try {
      await requestAs(c, platform, "select public.platform_grant_access($1, 'write', 'storage lifecycle race', 15)", [ws]);
      const path = `${ws}/logo.png`;
      const [req] = await requestAs<{ r: string }>(c, platform,
        "select public.platform_storage_change_requested('upsert', $1) r", [path]);
      const id = Number(req.r);
      await beginAsService(c);
      const token = (await c.query<{ r: string }>("select public.platform_storage_change_claimed($1, $2) r", [id, platform.id])).rows[0].r;
      await c.query("commit");
      await admin.query("update private.platform_storage_changes set claimed_at = claimed_at - interval '3 minutes' where request_id = $1", [id]);
      return { ws, owner1, path, id, token };
    } finally {
      await c.end();
    }
  }

  const outcomeRows = async (id: number) =>
    (await admin.query<{ outcome: string }>(
      "select metadata ->> 'outcome' outcome from public.workspace_audit_log where metadata ->> 'request_id' = $1", [String(id)])).rows;
  const objectOwner = async (path: string) =>
    (await admin.query<{ owner_id: string | null }>("select owner_id from storage.objects where name = $1", [path])).rows[0];

  test("recovery after the lease waits for an in-flight write of the same operation, then records its success", async () => {
    const op = await claimedUpsert();
    const a = await server.connect();
    const b = await server.connect();
    try {
      await beginAsService(a);
      await a.query(UPSERT, [op.path, { platform_operation: op.token }]);

      await beginAsService(b);
      const pending = settle(b.query(FINISHED, [op.id, platform.id]));
      await sleep(400);
      assert.ok(await waitingOnLock() >= 1, "recovery must wait for the in-flight operation");
      assert.equal(await Promise.race([pending.then(() => "settled"), sleep(50).then(() => "pending")]), "pending");

      await a.query("commit");
      const outcome = await pending;
      assert.equal(outcome.ok, true, errorOf(outcome));
      assert.equal(valueOf<string>(outcome), "succeeded");
      await b.query("commit");
      assert.deepEqual(await outcomeRows(op.id), [{ outcome: "succeeded" }]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("an in-flight write that aborts leaves recovery to record failure, and nothing is stored", async () => {
    const op = await claimedUpsert();
    const a = await server.connect();
    const b = await server.connect();
    try {
      await beginAsService(a);
      await a.query(UPSERT, [op.path, { platform_operation: op.token }]);
      await beginAsService(b);
      const pending = settle(b.query(FINISHED, [op.id, platform.id]));
      await sleep(400);
      assert.ok(await waitingOnLock() >= 1);
      await a.query("rollback");
      const outcome = await pending;
      assert.equal(valueOf<string>(outcome), "failed");
      await b.query("commit");
      assert.equal(await objectOwner(op.path), undefined);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("recovery first: the operation's write arriving while the outcome is being recorded is refused", async () => {
    const op = await claimedUpsert();
    const a = await server.connect();
    const b = await server.connect();
    try {
      await beginAsService(b);
      assert.equal((await b.query<{ r: string }>(FINISHED, [op.id, platform.id])).rows[0].r, "failed");

      await beginAsService(a);
      const late = settle(a.query(UPSERT, [op.path, { platform_operation: op.token }]));
      await sleep(400);
      assert.ok(await waitingOnLock() >= 1, "the late write waits for the recording transaction");
      await b.query("commit");
      const result = await late;
      assert.equal(result.ok, false);
      assert.match(errorOf(result), /platform_operation_closed/);
      await a.query("rollback");
      assert.equal(await objectOwner(op.path), undefined, "the late write never took effect");
      assert.deepEqual(await outcomeRows(op.id), [{ outcome: "failed" }]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("a member writing the same object concurrently neither blocks recovery nor counts as the platform's success", async () => {
    const op = await claimedUpsert();
    const a = await server.connect();
    const b = await server.connect();
    try {
      await beginAs(a, op.owner1);
      await a.query(MEMBER_UPSERT, [op.path, null]);

      await beginAsService(b);
      const outcome = await settle(b.query(FINISHED, [op.id, platform.id]));
      assert.equal(outcome.ok, true, errorOf(outcome));
      assert.equal(valueOf<string>(outcome), "failed", "a member's write is not the platform operation");
      await b.query("commit");
      await a.query("commit");
      assert.equal((await objectOwner(op.path))?.owner_id, op.owner1.id, "the member's own write stands");
      assert.deepEqual(await outcomeRows(op.id), [{ outcome: "failed" }]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

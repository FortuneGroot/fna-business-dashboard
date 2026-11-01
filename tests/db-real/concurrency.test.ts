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
    await a.query(first.sql, first.params);

    await beginAs(b, second.user);
    const pending = settle(b.query(second.sql, second.params));
    await sleep(400);
    const blocked = await waitingOnLock();
    const raced = await Promise.race([pending.then(() => "settled"), sleep(50).then(() => "pending")]);

    await a.query("commit");
    const outcome = await pending;
    await b.query(outcome.ok ? "commit" : "rollback");
    return { blocked, raced, outcome };
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

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { startRealPostgres, type RealPg } from "./realpg";

// M22: platform-admin changes serialize on one advisory lock, so two operators revoking different
// admins at once can never leave zero platform admins. Independent sessions (one pg.Client each)
// on a dedicated real local PostgreSQL server, as the service role (the operator CLI's path).

const META = JSON.stringify({ via: "realpg-test", env: "local" });
const REVOKE = "select public.platform_admin_revoke($1, 'Concurrent revocation test', $2::jsonb) r";
const GRANT = "select public.platform_admin_grant($1, $2::jsonb) r";
const DELETE = "delete from public.platform_admins where user_id = $1";
const LAST = /last_platform_admin/;
type Step = { sql: string; params: unknown[] };

let server: RealPg;
let admin: pg.Client;
let x: string;
let y: string;
let z: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function settle<T>(p: Promise<T>) {
  return p.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error }));
}
const errorOf = (o: { ok: boolean }) => (o as unknown as { error?: Error }).error?.message ?? "";

async function waitingOnLock(): Promise<number> {
  const r = await admin.query<{ n: number }>(
    "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
  return r.rows[0].n;
}

async function beginService(c: pg.Client) {
  await c.query("begin");
  await c.query("set local role service_role");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
}

const adminIds = async () =>
  (await admin.query<{ user_id: string }>("select user_id from public.platform_admins order by user_id")).rows.map((r) => r.user_id);

/** Leaves exactly `ids` as platform admins (superuser setup; the guard still keeps one at every step). */
async function setAdmins(ids: string[]) {
  for (const id of ids) await admin.query("insert into public.platform_admins (user_id) values ($1) on conflict do nothing", [id]);
  await admin.query("delete from public.platform_admins where not (user_id = any($1::uuid[]))", [ids]);
  assert.deepEqual(await adminIds(), [...ids].sort());
}

/** `first` runs and holds its transaction; `second` starts in another session and must wait; then `first` commits. */
async function serviceRace(first: Step, second: Step) {
  const a = await server.connect();
  const b = await server.connect();
  try {
    await beginService(a);
    await a.query(first.sql, first.params);
    await beginService(b);
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
  const user = async (email: string) =>
    (await admin.query<{ id: string }>("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
  x = await user("admin-race-x@example.test");
  y = await user("admin-race-y@example.test");
  z = await user("admin-race-z@example.test");
});

after(async () => {
  await admin?.end().catch(() => {});
  await server?.stop();
});

describe("real PostgreSQL: concurrent platform-admin revocations can never leave zero admins (M22)", () => {
  test("two operators each revoking one of two admins: the second waits and is refused; one admin remains", async () => {
    const pairs: [string, Step, Step][] = [
      ["function vs function", { sql: REVOKE, params: [x, META] }, { sql: REVOKE, params: [y, META] }],
      ["direct delete vs direct delete", { sql: DELETE, params: [x] }, { sql: DELETE, params: [y] }],
      ["function vs direct delete", { sql: REVOKE, params: [x, META] }, { sql: DELETE, params: [y] }],
      ["direct delete vs function", { sql: DELETE, params: [x] }, { sql: REVOKE, params: [y, META] }],
    ];
    for (const [label, first, second] of pairs) {
      await setAdmins([x, y]);
      const r = await serviceRace(first, second);
      assert.equal(r.raced, "pending", `${label}: the second change waits for the first transaction`);
      assert.ok(r.blocked >= 1, `${label}: the second change is waiting on a lock`);
      assert.equal(r.outcome.ok, false, `${label}: the second revocation must be refused`);
      assert.match(errorOf(r.outcome), LAST, label);
      assert.deepEqual(await adminIds(), [y], `${label}: exactly one admin remains`);
    }
  });

  test("grants follow the same lock: a revoke waits for a pending grant and then succeeds against its result", async () => {
    await setAdmins([x]);
    const r = await serviceRace({ sql: GRANT, params: [y, META] }, { sql: REVOKE, params: [x, META] });
    assert.equal(r.raced, "pending", "the revocation waits for the grant's transaction");
    assert.ok(r.blocked >= 1);
    assert.equal(r.outcome.ok, true, errorOf(r.outcome));
    assert.deepEqual(await adminIds(), [y]);
  });

  test("burst: 20 rounds of simultaneous revocations of all three admins never leave zero", async () => {
    const revokedAudits = async () => (await admin.query<{ n: number }>(
      "select count(*)::int n from public.platform_audit_log where action = 'platform.admin_revoked' and metadata->>'via' = 'realpg-test'")).rows[0].n;
    const baseline = await revokedAudits();
    for (let round = 0; round < 20; round++) {
      await setAdmins([x, y, z]);
      const results = await Promise.all([x, y, z].map(async (id) => {
        const c = await server.connect();
        try {
          await beginService(c);
          const res = await settle(c.query(REVOKE, [id, META]));
          await c.query(res.ok ? "commit" : "rollback");
          return res;
        } finally {
          await c.end();
        }
      }));
      assert.equal(results.filter((r) => r.ok).length, 2, `round ${round}: exactly two of three revocations succeed`);
      for (const refused of results.filter((r) => !r.ok)) assert.match(errorOf(refused), LAST);
      assert.equal((await adminIds()).length, 1, `round ${round}`);
      assert.equal(await revokedAudits(), baseline + 2 * (round + 1), "exactly one audit row per successful revocation");
    }
  });

  test("control: without the shared lock the same race removes both admins", async () => {
    await setAdmins([x, y]);
    await admin.query("alter table public.platform_admins disable trigger platform_admins_serialize");
    try {
      const r = await serviceRace({ sql: DELETE, params: [x] }, { sql: DELETE, params: [y] });
      assert.equal(r.raced, "settled", "without the lock the second delete does not wait");
      assert.equal(r.outcome.ok, true);
      assert.deepEqual(await adminIds(), [], "both admins removed: the race the lock prevents");
    } finally {
      await admin.query("alter table public.platform_admins enable trigger platform_admins_serialize");
    }
  });
});

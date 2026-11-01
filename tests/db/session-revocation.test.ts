import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { asAnon, asUser, buildWorld, createContact, rows, rpc, type TestUser, type World } from "./harness";

// M21: an access token is honoured only while its Auth session row exists, so logout (which
// deletes the row) ends reads and writes at once, before the token expires.

describe("session revocation (M21): a logged-out session's token is refused", () => {
  let w: World;
  let contactId: string;

  async function openSession(user: TestUser, notAfter: string | null = null): Promise<TestUser> {
    const r = await w.db.query<{ id: string }>(
      "insert into auth.sessions (user_id, not_after) values ($1, $2) returning id", [user.id, notAfter]);
    return { ...user, sessionId: r.rows[0].id };
  }
  const logout = (s: TestUser) => w.db.query("delete from auth.sessions where id = $1", [s.sessionId]);

  const contactCount = (u: TestUser) =>
    asUser(w.db, u, async (q) => (await rows<{ n: number }>(q, "select count(*)::int n from public.contacts"))[0].n);
  const context = (u: TestUser) => asUser(w.db, u, (q) => rpc<Record<string, unknown>>(q, "request_context"));

  before(async () => {
    w = await buildWorld();
    contactId = await createContact(w.db, w.employeeA, w.wsA, "Replay target");
  });
  after(async () => {
    await w.db.close();
  });

  test("a live session reads, writes, and passes the PostgREST pre-request check", async () => {
    const s = await openSession(w.employeeA);
    assert.equal((await context(s)).authenticated, true);
    assert.ok((await contactCount(s)) >= 1);
    await asUser(w.db, s, async (q) => {
      await rpc(q, "check_request_session");
      const u = await rows(q, "update public.contacts set first_name = 'Live edit' where id = $1 returning id", [contactId]);
      assert.equal(u.length, 1);
    });
  });

  test("after logout the same token reads nothing, writes nothing, and is reported signed out", async () => {
    const s = await openSession(w.employeeA);
    await logout(s);

    assert.deepEqual(await context(s), { authenticated: false });
    assert.equal(await contactCount(s), 0);
    await asUser(w.db, s, async (q) => {
      const u = await rows(q, "update public.contacts set first_name = 'Replayed' where id = $1 returning id", [contactId]);
      assert.equal(u.length, 0);
      assert.equal((await rows<{ p: boolean }>(q, "select private.has_permission('contacts.view') p"))[0].p, false);
    });
    await assert.rejects(
      asUser(w.db, s, (q) => q.query("insert into public.contacts (workspace_id, first_name) values ($1, 'Replayed')", [w.wsA])),
      /row-level security/);
    await assert.rejects(asUser(w.db, s, (q) => rpc(q, "check_request_session")), /session_ended/);
    const name = await w.db.query<{ first_name: string }>("select first_name from public.contacts where id = $1", [contactId]);
    assert.equal(name.rows[0].first_name, "Live edit");
  });

  test("logging out one session leaves the user's other sessions (other devices) working", async () => {
    const phone = await openSession(w.employeeA);
    const laptop = await openSession(w.employeeA);
    await logout(laptop);
    assert.equal((await context(phone)).authenticated, true);
    assert.ok((await contactCount(phone)) >= 1);
    assert.equal(await contactCount(laptop), 0);
  });

  test("a refreshed token keeps its session id and stays valid until that session ends", async () => {
    const s = await openSession(w.employeeA);
    const refreshed: TestUser = { ...s };
    assert.equal((await context(refreshed)).authenticated, true);
    await logout(s);
    assert.equal((await context(refreshed)).authenticated, false);
  });

  test("another user's session id, an expired session, and a malformed id are refused", async () => {
    const other = await openSession(w.employeeB);
    assert.equal((await context({ ...w.employeeA, sessionId: other.sessionId })).authenticated, false);
    const expired = await openSession(w.employeeA, new Date(Date.now() - 60_000).toISOString());
    assert.equal((await context(expired)).authenticated, false);
    assert.equal((await context({ ...w.employeeA, sessionId: "not-a-uuid" })).authenticated, false);
  });

  test("a platform admin's revoked session loses console access", async () => {
    const s = await openSession(w.platform);
    assert.equal((await asUser(w.db, s, (q) => rpc<{ active: boolean }>(q, "platform_status"))).active, true);
    await logout(s);
    assert.equal((await asUser(w.db, s, (q) => rpc<{ active: boolean }>(q, "platform_status"))).active, false);
    await assert.rejects(asUser(w.db, s, (q) => rpc(q, "platform_search_workspaces", [null, null, 10, null, null])));
  });

  test("anonymous requests pass the pre-request check (public invitation lookup still works)", async () => {
    await asAnon(w.db, (q) => rpc(q, "check_request_session"));
  });
});

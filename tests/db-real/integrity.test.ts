import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { beginAs, requestAs, startRealPostgres, type RealPg, type RealUser } from "./realpg";

// Review round 3 (M26): invitation authority at acceptance, platform-admin removal with grant
// history, and appointment rules under concurrency. Independent sessions on a real local server.

let server: RealPg;
let admin: pg.Client;
let platform: RealUser;
let seq = 0;

async function createUser(prefix: string, aal: "aal1" | "aal2" = "aal1", confirmed = true): Promise<RealUser> {
  seq += 1;
  const email = `${prefix}-${seq}@example.test`;
  const r = await admin.query<{ id: string }>(
    "insert into auth.users (email, email_confirmed_at) values ($1, case when $2 then now() end) returning id", [email, confirmed]);
  return { id: r.rows[0].id, email, aal };
}

async function newAdmin(): Promise<RealUser> {
  const u = await createUser("extra-platform", "aal2");
  await admin.query("insert into public.platform_admins (user_id) values ($1)", [u.id]);
  return u;
}

async function call<T = unknown>(user: RealUser, sql: string, params: unknown[] = []): Promise<T> {
  const c = await server.connect();
  try {
    return (await requestAs<{ r: T }>(c, user, sql, params))[0]?.r as T;
  } finally {
    await c.end();
  }
}

async function attempt<T = unknown>(user: RealUser, sql: string, params: unknown[] = []) {
  return call<T>(user, sql, params).then((value) => ({ ok: true as const, value, error: "" }),
    (e: Error) => ({ ok: false as const, value: undefined, error: e.message }));
}

/** A workspace provisioned by `by` with an owner (bootstrap accepted) and an admin member. */
async function workspace(by: RealUser = platform) {
  seq += 1;
  const owner = await createUser("owner");
  const adminMember = await createUser("admin");
  const prov = await call<{ workspace_id: string; invite_token: string }>(by,
    "select public.platform_provision_workspace($1, $2, $3, $4) r",
    [`synthetic-integrity-${seq}`, `Integrity ${seq} (synthetic)`, `integrity-${seq}`, owner.email]);
  await call(owner, "select public.accept_invitation($1) r", [prov.invite_token]);
  const inv = await call<{ token: string }>(owner, "select public.create_invitation($1, 'admin', 72) r", [adminMember.email]);
  await call(adminMember, "select public.accept_invitation($1) r", [inv.token]);
  return { ws: prov.workspace_id, owner, adminMember };
}

async function unclaimed(by: RealUser) {
  seq += 1;
  const owner = await createUser("unclaimed");
  const prov = await call<{ workspace_id: string; invite_token: string }>(by,
    "select public.platform_provision_workspace($1, $2, $3, $4) r",
    [`synthetic-unclaimed-int-${seq}`, `Unclaimed ${seq} (synthetic)`, `unclaimed-int-${seq}`, owner.email]);
  return { ws: prov.workspace_id, token: prov.invite_token, owner };
}

async function roleOf(ws: string, userId: string): Promise<string> {
  const r = await admin.query<{ role: string }>(
    "select role from public.workspace_members where workspace_id = $1 and user_id = $2 and status = 'active'", [ws, userId]);
  return r.rows[0]?.role ?? "none";
}

const ACCEPT = "select public.accept_invitation($1) r";
const PEEK = "select public.peek_invitation($1) r";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitingOnLock(): Promise<number> {
  const r = await admin.query<{ n: number }>(
    "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
  return r.rows[0].n;
}

/** `first` runs and holds its transaction; `second` must block; then `first` commits. */
async function race(first: { user: RealUser; sql: string; params: unknown[] }, second: { user: RealUser; sql: string; params: unknown[] }) {
  const a = await server.connect();
  const b = await server.connect();
  try {
    await beginAs(a, first.user);
    await a.query(first.sql, first.params);
    await beginAs(b, second.user);
    const pending = b.query(second.sql, second.params).then(
      (v) => ({ ok: true as const, error: "", rows: v.rows }), (e: Error) => ({ ok: false as const, error: e.message, rows: [] }));
    await sleep(400);
    const blocked = await waitingOnLock();
    await a.query("commit");
    const outcome = await pending;
    await b.query(outcome.ok ? "commit" : "rollback");
    return { blocked, outcome };
  } finally {
    await a.end();
    await b.end();
  }
}

before(async () => {
  server = await startRealPostgres();
  admin = await server.connect();
  platform = await createUser("integrity-platform", "aal2");
  await admin.query("insert into public.platform_admins (user_id) values ($1)", [platform.id]);
});

after(async () => {
  await admin?.end().catch(() => {});
  await server?.stop();
});

describe("real PostgreSQL: an invitation carries its issuer's authority only while it lasts", () => {
  test("an owner invites an owner and is then removed: the invitation is refused", async () => {
    const { ws, owner } = await workspace();
    const alt = await createUser("alt-address");
    const inv = await call<{ token: string }>(owner, "select public.create_invitation($1, 'owner', 72) r", [alt.email]);
    const otherOwner = await createUser("other-owner");
    const inv2 = await call<{ token: string }>(owner, "select public.create_invitation($1, 'owner', 72) r", [otherOwner.email]);
    await call(otherOwner, ACCEPT, [inv2.token]);
    await call(otherOwner, "select public.remove_member($1) r", [owner.id]);
    const refused = await attempt(alt, ACCEPT, [inv.token]);
    assert.match(refused.error, /invitation_revoked/);
    assert.equal(await roleOf(ws, alt.id), "none");
    assert.equal((await call<{ status: string }>(alt, PEEK, [inv.token])).status, "revoked");
  });

  test("an admin invites an employee and is then demoted: the invitation is refused", async () => {
    const { ws, owner, adminMember } = await workspace();
    const invitee = await createUser("demoted-invitee");
    const inv = await call<{ token: string }>(adminMember, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    await call(owner, "select public.set_member_role($1, 'employee') r", [adminMember.id]);
    assert.match((await attempt(invitee, ACCEPT, [inv.token])).error, /invitation_revoked/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });

  test("a revoked invitation never creates a membership", async () => {
    const { ws, owner } = await workspace();
    const invitee = await createUser("revoked-invitee");
    const inv = await call<{ token: string; invitation_id: string }>(owner, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    await call(owner, "select public.revoke_invitation($1) r", [inv.invitation_id]);
    assert.match((await attempt(invitee, ACCEPT, [inv.token])).error, /invitation_revoked/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });

  test("an employee invitation issued under a write grant is refused once the grant is revoked", async () => {
    const { ws } = await workspace();
    const grant = await call<{ id: string }>(platform, "select public.platform_grant_access($1, 'write', 'invitation authority test', 15) r", [ws]);
    const invitee = await createUser("grant-invitee");
    const inv = await call<{ token: string }>(platform, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    assert.equal((await call<{ status: string }>(invitee, PEEK, [inv.token])).status, "valid");
    await call(platform, "select public.platform_revoke_access($1, 'invitation authority test ended') r", [grant.id]);
    assert.equal((await call<{ status: string }>(invitee, PEEK, [inv.token])).status, "revoked");
    assert.match((await attempt(invitee, ACCEPT, [inv.token])).error, /invitation_revoked/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });

  test("an employee invitation issued under a live write grant is accepted", async () => {
    const { ws } = await workspace();
    await call(platform, "select public.platform_grant_access($1, 'write', 'invitation authority test', 15) r", [ws]);
    const invitee = await createUser("grant-ok");
    const inv = await call<{ token: string }>(platform, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    const ok = await attempt(invitee, ACCEPT, [inv.token]);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(await roleOf(ws, invitee.id), "employee");
  });

  test("a bootstrap invitation works while its issuer is a platform admin", async () => {
    const issuer = await newAdmin();
    const { ws, token, owner } = await unclaimed(issuer);
    const ok = await attempt(owner, ACCEPT, [token]);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(await roleOf(ws, owner.id), "owner");
  });

  test("a bootstrap invitation lapses when its issuer stops being a platform admin; another admin's rotation recovers", async () => {
    const issuer = await newAdmin();
    const { ws, token, owner } = await unclaimed(issuer);
    await admin.query("select public.platform_admin_revoke($1, 'integrity test removal', '{}')", [issuer.id]);
    assert.equal((await call<{ status: string }>(owner, PEEK, [token])).status, "revoked");
    assert.match((await attempt(owner, ACCEPT, [token])).error, /invitation_revoked/);
    assert.equal(await roleOf(ws, owner.id), "none");
    const rotated = await call<{ invite_token: string }>(platform,
      "select public.platform_rotate_bootstrap_invitation($1, 'issuer removed; reissuing') r", [ws]);
    const ok = await attempt(owner, ACCEPT, [rotated.invite_token]);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(await roleOf(ws, owner.id), "owner");
  });

  test("an account whose email is not confirmed cannot accept", async () => {
    const { ws, owner } = await workspace();
    const unconfirmed = await createUser("unconfirmed", "aal1", false);
    const inv = await call<{ token: string }>(owner, "select public.create_invitation($1, 'employee', 72) r", [unconfirmed.email]);
    assert.match((await attempt(unconfirmed, ACCEPT, [inv.token])).error, /invitation_email_unverified/);
    assert.equal(await roleOf(ws, unconfirmed.id), "none");
    await admin.query("update auth.users set email_confirmed_at = now() where id = $1", [unconfirmed.id]);
    assert.equal((await attempt(unconfirmed, ACCEPT, [inv.token])).ok, true);
  });

  test("repeating an acceptance whose response was lost succeeds for the same user and changes nothing", async () => {
    const { ws, owner } = await workspace();
    const invitee = await createUser("retry");
    const inv = await call<{ token: string; invitation_id: string }>(owner, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    await call(invitee, ACCEPT, [inv.token]);
    const again = await attempt<{ workspace: { id: string } }>(invitee, ACCEPT, [inv.token]);
    assert.equal(again.ok, true, again.error);
    assert.equal(again.value?.workspace.id, ws);
    const audits = await admin.query<{ n: number }>(
      "select count(*)::int n from public.workspace_audit_log where action = 'invitation.accepted' and target = $1", [inv.invitation_id]);
    assert.equal(audits.rows[0].n, 1);
    const other = await createUser("someone-else");
    assert.match((await attempt(other, ACCEPT, [inv.token])).error, /invitation_used/);
  });

  test("a used invitation of a member who was since removed cannot restore them", async () => {
    const { ws, owner } = await workspace();
    const invitee = await createUser("removed-retry");
    const inv = await call<{ token: string }>(owner, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    await call(invitee, ACCEPT, [inv.token]);
    await call(owner, "select public.remove_member($1) r", [invitee.id]);
    assert.match((await attempt(invitee, ACCEPT, [inv.token])).error, /invitation_used/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });
});

describe("real PostgreSQL: acceptance races the loss of the issuer's authority", () => {
  test("removal of the inviter first: the waiting acceptance is refused", async () => {
    const { ws, owner, adminMember } = await workspace();
    const invitee = await createUser("race-removal");
    const inv = await call<{ token: string }>(adminMember, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    const r = await race({ user: owner, sql: "select public.remove_member($1)", params: [adminMember.id] },
      { user: invitee, sql: ACCEPT, params: [inv.token] });
    assert.ok(r.blocked >= 1, "acceptance must wait for the removal");
    assert.match(r.outcome.error, /invitation_revoked/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });

  test("acceptance first: the removal waits, and the membership granted under live authority stands", async () => {
    const { ws, owner, adminMember } = await workspace();
    const invitee = await createUser("race-accept");
    const inv = await call<{ token: string }>(adminMember, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    const r = await race({ user: invitee, sql: ACCEPT, params: [inv.token] },
      { user: owner, sql: "select public.remove_member($1)", params: [adminMember.id] });
    assert.ok(r.blocked >= 1);
    assert.equal(r.outcome.ok, true, r.outcome.error);
    assert.equal(await roleOf(ws, invitee.id), "employee");
    assert.equal(await roleOf(ws, adminMember.id), "none");
  });

  test("demotion of the inviter first: the waiting acceptance is refused", async () => {
    const { ws, owner, adminMember } = await workspace();
    const invitee = await createUser("race-demotion");
    const inv = await call<{ token: string }>(adminMember, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    const r = await race({ user: owner, sql: "select public.set_member_role($1, 'employee')", params: [adminMember.id] },
      { user: invitee, sql: ACCEPT, params: [inv.token] });
    assert.ok(r.blocked >= 1);
    assert.match(r.outcome.error, /invitation_revoked/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });

  test("grant revocation first: the waiting acceptance is refused", async () => {
    const { ws } = await workspace();
    const grant = await call<{ id: string }>(platform, "select public.platform_grant_access($1, 'write', 'grant race regression', 15) r", [ws]);
    const invitee = await createUser("race-grant");
    const inv = await call<{ token: string }>(platform, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    const r = await race({ user: platform, sql: "select public.platform_revoke_access($1, 'race test grant ended')", params: [grant.id] },
      { user: invitee, sql: ACCEPT, params: [inv.token] });
    assert.ok(r.blocked >= 1, "acceptance must wait for the revocation");
    assert.match(r.outcome.error, /invitation_revoked/);
    assert.equal(await roleOf(ws, invitee.id), "none");
  });

  test("acceptance first: the grant revocation waits, then ends the grant; the membership stands", async () => {
    const { ws } = await workspace();
    const grant = await call<{ id: string }>(platform, "select public.platform_grant_access($1, 'write', 'grant race regression', 15) r", [ws]);
    const invitee = await createUser("race-grant-accept");
    const inv = await call<{ token: string }>(platform, "select public.create_invitation($1, 'employee', 72) r", [invitee.email]);
    const r = await race({ user: invitee, sql: ACCEPT, params: [inv.token] },
      { user: platform, sql: "select public.platform_revoke_access($1, 'race test grant ended')", params: [grant.id] });
    assert.ok(r.blocked >= 1);
    assert.equal(r.outcome.ok, true, r.outcome.error);
    assert.equal(await roleOf(ws, invitee.id), "employee");
  });
});

describe("real PostgreSQL: removing a platform admin who has grant history", () => {
  const REVOKE = "select public.platform_admin_revoke($1, 'integrity test removal', '{}') r";

  test("an admin with a live read grant is removed; the grant ends at once and its history stays", async () => {
    const extra = await newAdmin();
    const { ws } = await workspace();
    const grant = await call<{ id: string }>(extra, "select public.platform_grant_access($1, 'read', 'removal test', 15) r", [ws]);
    const r = await admin.query<{ r: { changed: boolean } }>(REVOKE, [extra.id]);
    assert.equal(r.rows[0].r.changed, true);
    const row = (await admin.query("select admin_user_id, revoked_at from public.platform_access_grants where id = $1", [grant.id])).rows[0];
    assert.equal(row.admin_user_id, extra.id);
    assert.notEqual(row.revoked_at, null);
    const ctx = await call<{ workspace: unknown; is_platform_admin: boolean }>(extra, "select public.request_context() r");
    assert.equal(ctx.workspace, null);
    assert.equal(ctx.is_platform_admin, false);
    const seen = await call<number>(extra, "select count(*)::int r from public.workspaces");
    assert.equal(seen, 0);
    const audit = await admin.query<{ metadata: { user_id: string; ended_grant_ids: string[] } }>(
      "select metadata from public.platform_audit_log where action = 'platform.admin_revoked' and metadata ->> 'user_id' = $1", [extra.id]);
    assert.deepEqual(audit.rows.map((a) => a.metadata.ended_grant_ids), [[grant.id]]);
  });

  test("an admin with a write grant who authored notes and messages is removed; authorship and audit are preserved", async () => {
    const extra = await newAdmin();
    const { ws } = await workspace();
    const grant = await call<{ id: string }>(extra, "select public.platform_grant_access($1, 'write', 'removal test', 15) r", [ws]);
    const contact = await call<string>(extra,
      "insert into public.contacts (workspace_id, first_name) values ($1, 'Grant contact') returning id r", [ws]);
    await call(extra, "insert into public.contact_notes (workspace_id, contact_id, body) values ($1, $2, 'grant note') returning id r", [ws, contact]);
    const conv = await call<string>(extra,
      "insert into public.conversations (workspace_id, contact_id, channel) values ($1, $2, 'internal') returning id r", [ws, contact]);
    await call(extra, "insert into public.messages (workspace_id, conversation_id, direction, body) values ($1, $2, 'internal', 'grant message') returning id r", [ws, conv]);
    const before = await admin.query("select count(*)::int n from public.workspace_audit_log where grant_id = $1", [grant.id]);

    await admin.query(REVOKE, [extra.id]);

    const note = (await admin.query("select author_id, author_grant_id from public.contact_notes where contact_id = $1", [contact])).rows[0];
    assert.deepEqual(note, { author_id: extra.id, author_grant_id: grant.id });
    const msg = (await admin.query("select author_user_id, author_grant_id from public.messages where conversation_id = $1", [conv])).rows[0];
    assert.deepEqual(msg, { author_user_id: extra.id, author_grant_id: grant.id });
    const afterCount = await admin.query("select count(*)::int n from public.workspace_audit_log where grant_id = $1", [grant.id]);
    assert.ok(afterCount.rows[0].n >= before.rows[0].n);
    await assert.rejects(call(extra,
      "insert into public.contacts (workspace_id, first_name) values ($1, 'After removal') returning id r", [ws]), /row-level security/);
    await assert.rejects(call(extra, "select public.platform_grant_access($1, 'write', 'after removal attempt', 15) r", [ws]), /forbidden/);
  });

  test("an admin whose grants already ended is removed; their ending is not rewritten", async () => {
    const extra = await newAdmin();
    const a = await workspace();
    const b = await workspace();
    const revoked = await call<{ id: string }>(extra, "select public.platform_grant_access($1, 'read', 'removal test', 15) r", [a.ws]);
    await call(extra, "select public.platform_revoke_access($1, 'ended before removal') r", [revoked.id]);
    const expired = await call<{ id: string }>(extra, "select public.platform_grant_access($1, 'read', 'removal test', 15) r", [b.ws]);
    await admin.query(`update public.platform_access_grants
      set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1`, [expired.id]);
    const snapshot = async () => (await admin.query(
      "select id, revoked_at, revoked_by, expires_at from public.platform_access_grants where admin_user_id = $1 order by id", [extra.id])).rows;
    const before = await snapshot();
    await admin.query(REVOKE, [extra.id]);
    assert.deepEqual(await snapshot(), before);
    const audit = await admin.query<{ metadata: { ended_grant_ids: string[] } }>(
      "select metadata from public.platform_audit_log where action = 'platform.admin_revoked' and metadata ->> 'user_id' = $1", [extra.id]);
    assert.deepEqual(audit.rows[0].metadata.ended_grant_ids, []);
  });

  test("the last platform admin still cannot be removed", async () => {
    const r = await admin.query<{ n: number }>("select count(*)::int n from public.platform_admins");
    const ids = (await admin.query<{ user_id: string }>("select user_id from public.platform_admins where user_id <> $1", [platform.id])).rows;
    for (const { user_id } of ids) await admin.query(REVOKE, [user_id]);
    assert.ok(r.rows[0].n >= 1);
    await assert.rejects(admin.query(REVOKE, [platform.id]), /last_platform_admin/);
  });
});

describe("real PostgreSQL: appointment rules hold under concurrency", () => {
  async function bookingFixture() {
    const { ws, owner } = await workspace();
    const calendar = await call<string>(owner, "select public.save_calendar(null, $1::jsonb) r",
      [JSON.stringify({ name: `Chairs ${seq}`, slug: `chairs-${seq}`, duration_minutes: 60 })]);
    const contact = await call<string>(owner,
      "insert into public.contacts (workspace_id, first_name) values ($1, 'Booking') returning id r", [ws]);
    return { ws, owner, calendar, contact };
  }
  const INSERT = `insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at)
    values (private.active_workspace_id(), $1, $2, $3, $4) returning id`;
  const DEACTIVATE = "update public.calendars set active = false where id = $1";

  test("deactivation first: a booking waiting on it is refused as calendar_inactive", async () => {
    const f = await bookingFixture();
    const r = await race({ user: f.owner, sql: DEACTIVATE, params: [f.calendar] },
      { user: f.owner, sql: INSERT, params: [f.calendar, f.contact, "2034-03-01T10:00:00Z", "2034-03-01T11:00:00Z"] });
    assert.ok(r.blocked >= 1, "the booking must wait for the deactivation");
    assert.match(r.outcome.error, /calendar_inactive/);
    const n = await admin.query<{ n: number }>("select count(*)::int n from public.appointments where calendar_id = $1", [f.calendar]);
    assert.equal(n.rows[0].n, 0);
  });

  test("booking first: the deactivation waits; the booking made while active stands", async () => {
    const f = await bookingFixture();
    const r = await race({ user: f.owner, sql: INSERT, params: [f.calendar, f.contact, "2034-03-02T10:00:00Z", "2034-03-02T11:00:00Z"] },
      { user: f.owner, sql: DEACTIVATE, params: [f.calendar] });
    assert.ok(r.blocked >= 1);
    assert.equal(r.outcome.ok, true, r.outcome.error);
    const n = await admin.query<{ n: number }>("select count(*)::int n from public.appointments where calendar_id = $1", [f.calendar]);
    assert.equal(n.rows[0].n, 1);
  });

  test("on an inactive calendar: no booking, reschedule, or re-booking; cancel and history still work", async () => {
    const f = await bookingFixture();
    const id = await call<string>(f.owner, INSERT.replace("returning id", "returning id r"),
      [f.calendar, f.contact, "2034-03-03T10:00:00Z", "2034-03-03T11:00:00Z"]);
    const cancelledId = await call<string>(f.owner, INSERT.replace("returning id", "returning id r"),
      [f.calendar, f.contact, "2034-03-04T10:00:00Z", "2034-03-04T11:00:00Z"]);
    await call(f.owner, "update public.appointments set status = 'cancelled' where id = $1 returning id r", [cancelledId]);
    await call(f.owner, "update public.calendars set active = false where id = $1 returning id r", [f.calendar]);
    assert.match((await attempt(f.owner, INSERT.replace("returning id", "returning id r"),
      [f.calendar, f.contact, "2034-03-05T10:00:00Z", "2034-03-05T11:00:00Z"])).error, /calendar_inactive/);
    assert.match((await attempt(f.owner, "update public.appointments set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1 returning id r", [id])).error, /calendar_inactive/);
    assert.match((await attempt(f.owner, "update public.appointments set status = 'booked' where id = $1 returning id r", [cancelledId])).error, /calendar_inactive/);
    assert.equal((await attempt(f.owner, "update public.appointments set status = 'cancelled' where id = $1 returning id r", [id])).ok, true);
    const history = await call<number>(f.owner, "select count(*)::int r from public.appointments where calendar_id = $1", [f.calendar]);
    assert.equal(history, 2);
  });

  test("two sessions moving the start and the end of one booking cannot store more than 24 hours", async () => {
    const f = await bookingFixture();
    const id = await call<string>(f.owner, INSERT.replace("returning id", "returning id r"),
      [f.calendar, f.contact, "2034-04-01T10:00:00Z", "2034-04-01T11:00:00Z"]);
    const r = await race(
      { user: f.owner, sql: "update public.appointments set starts_at = '2034-03-31T14:00:00Z' where id = $1", params: [id] },
      { user: f.owner, sql: "update public.appointments set ends_at = '2034-04-02T07:00:00Z' where id = $1", params: [id] });
    assert.ok(r.blocked >= 1);
    assert.match(r.outcome.error, /appointment_too_long/);
    const row = (await admin.query("select ends_at - starts_at d from public.appointments where id = $1", [id])).rows[0];
    assert.equal(row.d.hours, 21);
  });

  test("the 24-hour limit is inclusive at exactly 24 hours and refuses one second more", async () => {
    const f = await bookingFixture();
    const exact = await attempt(f.owner, INSERT.replace("returning id", "returning id r"),
      [f.calendar, f.contact, "2034-05-01T00:00:00Z", "2034-05-02T00:00:00Z"]);
    assert.equal(exact.ok, true, exact.error);
    assert.match((await attempt(f.owner, INSERT.replace("returning id", "returning id r"),
      [f.calendar, f.contact, "2034-05-03T00:00:00Z", "2034-05-04T00:00:01Z"])).error, /appointment_too_long/);
  });

  test("an existing booking longer than 24 hours can still be cancelled but not moved", async () => {
    const f = await bookingFixture();
    await admin.query("alter table public.appointments disable trigger appointments_rules");
    let id = "";
    try {
      id = (await admin.query<{ id: string }>(
        `insert into public.appointments (workspace_id, calendar_id, contact_id, starts_at, ends_at)
         values ($1, $2, $3, '2034-06-01T00:00:00Z', '2034-06-03T00:00:00Z') returning id`, [f.ws, f.calendar, f.contact])).rows[0].id;
    } finally {
      await admin.query("alter table public.appointments enable trigger appointments_rules");
    }
    assert.match((await attempt(f.owner, "update public.appointments set starts_at = starts_at + interval '1 hour' where id = $1 returning id r", [id])).error, /appointment_too_long/);
    assert.equal((await attempt(f.owner, "update public.appointments set status = 'cancelled' where id = $1 returning id r", [id])).ok, true);
  });
});

describe("real PostgreSQL: simultaneous provisioning of one key", () => {
  test("many sessions provisioning the same key at once all get the one workspace, never a conflict", async () => {
    const conflicts: string[] = [];
    for (let round = 0; round < 25; round++) {
      seq += 1;
      const args = [`synthetic-burst-${seq}`, `Burst ${seq} (synthetic)`, `burst-${seq}`, `burst-owner-${seq}@example.test`];
      const clients = await Promise.all(Array.from({ length: 6 }, () => server.connect()));
      try {
        const results = await Promise.allSettled(clients.map((c) =>
          requestAs<{ r: { workspace_id: string; created: boolean } }>(c, platform, "select public.platform_provision_workspace($1, $2, $3, $4) r", args)));
        const ok = results.filter((r): r is PromiseFulfilledResult<{ r: { workspace_id: string; created: boolean } }[]> => r.status === "fulfilled");
        for (const r of results) if (r.status === "rejected") conflicts.push(`round ${round}: ${(r.reason as Error).message}`);
        assert.ok(new Set(ok.map((r) => r.value[0].r.workspace_id)).size <= 1, "one workspace");
        assert.ok(ok.filter((r) => r.value[0].r.created).length <= 1, "created at most once");
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      const n = await admin.query<{ n: number }>("select count(*)::int n from public.workspaces where provisioning_key = $1", [args[0]]);
      assert.equal(n.rows[0].n, 1);
    }
    assert.deepEqual(conflicts, [], `${conflicts.length} of ${25 * 6} calls failed`);
  });
});

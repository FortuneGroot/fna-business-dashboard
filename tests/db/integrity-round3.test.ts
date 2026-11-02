import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { adminCount, asServiceRole, asUser, buildWorld, createUser, invite, rows, rpc, type World } from "./harness";

// M26 (review round 3) parts that need no concurrent sessions: the logo swap, append-only TRUNCATE,
// AAL2 without exceptions, session-bound visibility, and issuer authority in preview and signup.
// Concurrency is covered by tests/db-real/integrity.test.ts.

let w: World;
const UUID = "0d7f4a52-9a51-4c1e-8f43-2f6f0d1a3b11";

before(async () => {
  w = await buildWorld();
});

after(async () => {
  await w.db.close();
});

async function putObject(path: string) {
  await asUser(w.db, w.ownerA, (q) => rows(q,
    "insert into storage.objects (bucket_id, name, owner_id) values ('workspace-assets', $1, auth.uid()::text)", [path]));
}

const logoPath = async () =>
  (await w.db.query<{ p: string | null }>("select logo_path p from public.workspace_settings where workspace_id = $1", [w.wsA])).rows[0].p;

describe("M26: the workspace logo is recorded only through set_workspace_logo", () => {
  test("a stored object of the active workspace is recorded, and the previous path is returned for removal", async () => {
    const first = `${w.wsA}/logo-${UUID}.png`;
    const second = `${w.wsA}/logo-${UUID.replace("0d7f", "1e8a")}.webp`;
    await putObject(first);
    await putObject(second);
    const a = await asUser(w.db, w.ownerA, (q) => rpc<{ previous: string | null; changed: boolean }>(q, "set_workspace_logo", [first]));
    assert.deepEqual(a, { previous: null, changed: true });
    const b = await asUser(w.db, w.ownerA, (q) => rpc<{ previous: string | null; changed: boolean }>(q, "set_workspace_logo", [second]));
    assert.deepEqual(b, { previous: first, changed: true });
    assert.equal(await logoPath(), second);
    const audit = await adminCount(w.db,
      "select count(*) n from public.workspace_audit_log where workspace_id = $1 and metadata::text like '%logo_path%'", [w.wsA]);
    const events = await adminCount(w.db,
      "select count(*) n from public.activity_events where workspace_id = $1 and payload::text like '%logo_path%'", [w.wsA]);
    assert.ok(audit + events >= 2, "logo changes are recorded like other settings changes");
  });

  test("p_only_if changes nothing unless the current logo is exactly that path", async () => {
    const current = await logoPath();
    const r = await asUser(w.db, w.ownerA, (q) => rpc<{ previous: string; changed: boolean }>(q, "set_workspace_logo", [null, `${w.wsA}/logo.png`]));
    assert.deepEqual(r, { previous: current, changed: false });
    assert.equal(await logoPath(), current);
  });

  test("a path that is missing, malformed, or in another workspace is refused", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "set_workspace_logo", [`${w.wsA}/logo-${UUID.replace("0d7f", "2f9b")}.png`])), /logo_missing/);
    for (const bad of [`${w.wsB}/logo.png`, `${w.wsA}/logo.gif`, `${w.wsA}/../logo.png`, `${w.wsA}/avatar.png`]) {
      await assert.rejects(asUser(w.db, w.ownerA, (q) => rpc(q, "set_workspace_logo", [bad])), /validation_failed/, bad);
    }
  });

  test("an employee without settings.write and an outsider cannot change it", async () => {
    await assert.rejects(asUser(w.db, w.employeeA, (q) => rpc(q, "set_workspace_logo", [null])), /forbidden/);
    await assert.rejects(asUser(w.db, w.outsider, (q) => rpc(q, "set_workspace_logo", [null])), /no_active_workspace|forbidden/);
  });

  test("clients can no longer write logo_path directly, and the table refuses a foreign path", async () => {
    await assert.rejects(asUser(w.db, w.ownerA, (q) => rows(q,
      "update public.workspace_settings set logo_path = null where workspace_id = $1", [w.wsA])), /permission denied/);
    await assert.rejects(w.db.query("update public.workspace_settings set logo_path = $1 where workspace_id = $2",
      [`${w.wsB}/logo.png`, w.wsA]), /workspace_settings_logo_path_format/);
  });

  test("clearing returns the previous path", async () => {
    const current = await logoPath();
    const r = await asUser(w.db, w.ownerA, (q) => rpc<{ previous: string; changed: boolean }>(q, "set_workspace_logo", [null]));
    assert.deepEqual(r, { previous: current, changed: true });
    assert.equal(await logoPath(), null);
  });
});

describe("M26: append-only tables refuse TRUNCATE", () => {
  for (const table of ["activity_events", "workspace_audit_log", "platform_audit_log"]) {
    test(`${table}: even the table owner and the service role cannot truncate it`, async () => {
      const before = await adminCount(w.db, `select count(*) n from public.${table}`);
      await assert.rejects(w.db.query(`truncate public.${table} cascade`), /append-only/);
      await assert.rejects(asServiceRole(w.db, (q) => q.query(`truncate public.${table} cascade`)), /append-only|permission denied/);
      assert.equal(await adminCount(w.db, `select count(*) n from public.${table}`), before);
    });
  }
});

describe("M26: platform admins need AAL2 with no session-setting exception", () => {
  test("app.platform_allow_aal1 = on no longer admits an AAL1 platform session", async () => {
    const aal1 = { ...w.platform, aal: "aal1" as const };
    const r = await asUser(w.db, aal1, async (q) => {
      await q.query("select set_config('app.platform_allow_aal1', 'on', true)");
      return (await rows<{ a: boolean }>(q, "select (public.request_context() ->> 'is_platform_admin')::boolean a"))[0].a;
    });
    assert.equal(r, false);
  });
});

describe("M26: own profile and workspace names need a live session", () => {
  test("a token whose session ended reads neither its own profile nor its workspace", async () => {
    const live = await w.db.query<{ id: string }>("insert into auth.sessions (user_id) values ($1) returning id", [w.ownerA.id]);
    const liveUser = { ...w.ownerA, sessionId: live.rows[0].id };
    const read = (u: typeof liveUser) => asUser(w.db, u, async (q) => ({
      profile: (await rows(q, "select user_id from public.profiles where user_id = auth.uid()")).length,
      workspaces: (await rows(q, "select id from public.workspaces")).length,
    }));
    const before = await read(liveUser);
    assert.equal(before.profile, 1);
    assert.ok(before.workspaces >= 1);
    await w.db.query("delete from auth.sessions where id = $1", [live.rows[0].id]);
    assert.deepEqual(await read(liveUser), { profile: 0, workspaces: 0 });
  });
});

describe("M26: preview and signup follow the issuer's current authority", () => {
  test("an invitation issued under a write grant previews as revoked and cannot start a signup once the grant ends", async () => {
    const grant = await asUser(w.db, w.platform, (q) => rpc<{ id: string }>(q, "platform_grant_access", [w.wsB, "write", "Round 3 preview check (synthetic)", 30]));
    const token = await invite(w.db, w.platform, "round3-newcomer@example.test", "employee");
    const peek = async () => (await asUser(w.db, w.outsider, (q) => rpc<{ status: string }>(q, "peek_invitation", [token]))).status;
    assert.equal(await peek(), "valid");
    assert.equal(await asServiceRole(w.db, (q) => rpc<string>(q, "invitation_signup_email", [token])), "round3-newcomer@example.test");

    await asUser(w.db, w.platform, (q) => rpc(q, "platform_revoke_access", [grant.id, "Round 3 preview check ended"]));
    assert.equal(await adminCount(w.db, "select count(*) n from public.workspace_invitations where token_hash = private.hash_token($1) and revoked_at is null", [token]), 1,
      "the invitation row itself is untouched; its issuer's authority ended");
    assert.equal(await peek(), "revoked");
    await assert.rejects(asServiceRole(w.db, (q) => rpc(q, "invitation_signup_email", [token])), /invitation_revoked/);
  });

  test("bootstrap owner invitations from a live platform admin still preview as valid", async () => {
    const owner = await createUser(w.db, "round3-bootstrap@example.test");
    const prov = await asUser(w.db, w.platform, (q) => rpc<{ invite_token: string }>(q, "platform_provision_workspace",
      ["synthetic-round3", "Round 3 (synthetic)", "round3-synthetic", owner.email]));
    const status = (await asUser(w.db, owner, (q) => rpc<{ status: string }>(q, "peek_invitation", [prov.invite_token]))).status;
    assert.equal(status, "valid");
  });
});

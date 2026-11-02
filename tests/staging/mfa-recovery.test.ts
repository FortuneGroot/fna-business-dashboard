// Hosted MFA-recovery rehearsal (release Gate B): the real `bootstrap-platform-admin.ts remove-mfa`
// code path against the staging project, for a synthetic platform admin only. Run on purpose only:
//
//   STAGING_REHEARSAL=1 STAGING_PROJECT_REF=... STAGING_APP_URL=http://localhost:3000 (+ staging keys)
//   node --require ./scripts/stub-server-only.cjs --import tsx --test tests/staging/mfa-recovery.test.ts
//
// Every account it creates is @example.test and is deleted afterwards. Accounts that are not
// synthetic (George's) are fingerprinted before and after: users, password hashes, MFA factors,
// sessions and platform-admin rows must be identical. Keys are never printed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { checkTarget, confirmationPhrase, parseArgs, run } from "../../scripts/bootstrap-platform-admin";
import { appFetch, cookieHeader, readSessionCookie, rest, sessionCookie, totp, type GoTrueSession } from "../supabase-stack/stack";
import { connectStaging, createAccount, passwordToken, revokeAdmin, type Account, type Staging } from "./env";
import { assertAuthRejected } from "../helpers/recovery-assertions";

const runId = `mfa${Date.now().toString(36)}`;
const email = (who: string) => `${who}-${runId}@example.test`;
const REASON = "Hosted MFA recovery rehearsal (synthetic)";

let s: Staging;
let admin: Account;
let bystander: Account;
let georgeBefore: Record<string, unknown>;

const notSynthetic = "u.email not like '%@example.test'";
async function realAccountsFingerprint() {
  const r = await s.db.query(`
    select
      (select md5(coalesce(jsonb_agg(to_jsonb(u) order by u.id)::text, '[]')) from auth.users u where ${notSynthetic}) users,
      (select md5(coalesce(jsonb_agg(to_jsonb(f) order by f.id)::text, '[]')) from auth.mfa_factors f join auth.users u on u.id = f.user_id where ${notSynthetic}) factors,
      (select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.id)::text, '[]')) from auth.sessions x join auth.users u on u.id = x.user_id where ${notSynthetic}) sessions,
      (select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.user_id)::text, '[]')) from public.platform_admins p join auth.users u on u.id = p.user_id where ${notSynthetic}) admins`);
  return r.rows[0];
}

const count = async (sql: string, id: string) => Number((await s.db.query(sql, [id])).rows[0].n);
const sessionsOf = (id: string) => count("select count(*) n from auth.sessions where user_id = $1", id);
const factorsOf = (id: string) => count("select count(*) n from auth.mfa_factors where user_id = $1", id);
const liveRefreshOf = (id: string) => count("select count(*) n from auth.refresh_tokens where user_id = $1::text and not revoked", id);
const auditOf = async (id: string) => (await s.db.query<{ action: string; reason: string; metadata: any }>(
  "select action, reason, metadata from public.platform_audit_log where metadata->>'user_id' = $1 and action like 'platform.%' order by id", [id])).rows;

const anonHeaders = (token?: string) => ({
  apikey: s.env.anonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const rpc = (token: string, fn: string) => rest(s.env, token, "POST", `rpc/${fn}`, {});
const authUser = (token: string) => fetch(`${s.env.apiUrl}/auth/v1/user`, { headers: anonHeaders(token) });
const refresh = async (refreshToken: string) => fetch(`${s.env.apiUrl}/auth/v1/token?grant_type=refresh_token`, {
  method: "POST", headers: anonHeaders(), body: JSON.stringify({ refresh_token: refreshToken }),
});
const me = async (cookie: string) => (await appFetch(s.app, "/api/auth/me", { cookie })).body;

/** Enrols and verifies a TOTP factor; returns the full AAL2 GoTrue session. */
async function enrolAal2(token: string): Promise<GoTrueSession> {
  const en: any = await (await fetch(`${s.env.apiUrl}/auth/v1/factors`, {
    method: "POST", headers: anonHeaders(token), body: JSON.stringify({ factor_type: "totp", friendly_name: `staging-${runId}` }),
  })).json();
  assert.ok(en?.id && en?.totp?.secret, "TOTP enrolment");
  const ch: any = await (await fetch(`${s.env.apiUrl}/auth/v1/factors/${en.id}/challenge`, { method: "POST", headers: anonHeaders(token), body: "{}" })).json();
  const v = await fetch(`${s.env.apiUrl}/auth/v1/factors/${en.id}/verify`, {
    method: "POST", headers: anonHeaders(token), body: JSON.stringify({ challenge_id: ch.id, code: totp(en.totp.secret) }),
  });
  assert.equal(v.status, 200, "TOTP verify");
  return (await v.json()) as GoTrueSession;
}

/** The real CLI code path against staging; the typed confirmation is answered only for this synthetic account. */
async function removeMfa(): Promise<{ code: number; lines: string[] }> {
  return operator("remove-mfa", admin);
}

async function operator(command: "remove-mfa" | "end-sessions", account: Account): Promise<{ code: number; lines: string[] }> {
  const argv = [command, "--email", account.email, "--env", "staging", "--reason", REASON];
  const phrase = confirmationPhrase(parseArgs(argv), checkTarget("staging", s.env.apiUrl));
  assert.ok(account.email.endsWith("@example.test") && phrase.includes(account.email) && phrase.includes(`${s.ref}.supabase.co`), "confirmation names the synthetic account and staging");
  const lines: string[] = [];
  const code = await run(argv, {
    env: { SUPABASE_URL: s.env.apiUrl, SUPABASE_SERVICE_ROLE_KEY: s.env.serviceRoleKey },
    fetch, log: (l) => lines.push(l), prompt: async () => phrase,
  });
  assert.ok(lines.every((l) => !l.includes(s.env.serviceRoleKey)), "the CLI never prints the key");
  return { code, lines };
}

async function deleteUser(id: string) {
  const response = await fetch(`${s.env.apiUrl}/auth/v1/admin/users/${id}`, {
    method: "DELETE", headers: { apikey: s.env.serviceRoleKey, Authorization: `Bearer ${s.env.serviceRoleKey}` },
  });
  assert.equal(response.status, 200, "synthetic user deletion");
}

describe("hosted MFA recovery rehearsal on staging (synthetic admin only)", () => {
  let device: GoTrueSession;
  let secondDevice: string;
  let adminCookie: string;
  let bystanderToken: string;
  let bystanderCookie: string;

  before(async () => {
    s = await connectStaging();
    georgeBefore = await realAccountsFingerprint();
    admin = await createAccount(s.env, email("admin"), `Stg-${runId}-A1!x`, "Recovery Admin (synthetic)");
    bystander = await createAccount(s.env, email("bystander"), `Stg-${runId}-B1!x`, "Bystander (synthetic)");
    await s.db.query("select public.platform_admin_grant($1, $2)", [admin.id, { via: "tests/staging/mfa-recovery.test.ts" }]);
    device = await enrolAal2(await passwordToken(s.env, admin));
    secondDevice = await passwordToken(s.env, admin);
    bystanderToken = await passwordToken(s.env, bystander);
    const login = await appFetch(s.app, "/api/auth/login", { method: "POST", json: { email: bystander.email, password: bystander.password } });
    assert.equal(login.status, 200, "bystander app login");
    bystanderCookie = cookieHeader(login.setCookies);
    adminCookie = sessionCookie(readSessionCookie(bystanderCookie).name, device);
  });

  after(async () => {
    try {
      await s.db.query("drop trigger if exists test_fail_sessions_audit on public.platform_audit_log").catch(() => undefined);
      await s.db.query("drop function if exists public.test_fail_sessions_audit()").catch(() => undefined);
      if (admin) await revokeAdmin(s, admin.id, "Hosted MFA recovery rehearsal finished");
      for (const a of [admin, bystander]) if (a) await deleteUser(a.id);
      const left = await s.db.query<{ n: number }>("select count(*)::int n from auth.users where email like $1", [`%-${runId}@example.test`]);
      assert.equal(left.rows[0].n, 0, "synthetic accounts removed");
      assert.equal(Number((await s.db.query("select count(*) n from public.workspaces")).rows[0].n), 0, "no workspaces remain");
      assert.deepEqual(await realAccountsFingerprint(), georgeBefore, "non-synthetic accounts unchanged after cleanup");
    } finally {
      await s?.db.end();
    }
  });

  test("before recovery: the lost device holds working AAL2 access, a refresh token, and an app session", async () => {
    assert.equal((await rpc(device.access_token, "platform_status")).body.active, true);
    const r = await refresh(device.refresh_token);
    assert.equal(r.status, 200, "refresh works before recovery");
    const rotated = (await r.json()) as GoTrueSession;
    device = { ...device, access_token: rotated.access_token, refresh_token: rotated.refresh_token };
    adminCookie = sessionCookie(readSessionCookie(bystanderCookie).name, device);
    const view = await me(adminCookie);
    assert.deepEqual([view.user?.id, view.isPlatformAdmin], [admin.id, true], "app session is AAL2 platform admin");
    assert.equal((await authUser(secondDevice)).status, 200);
    assert.equal(await sessionsOf(admin.id), 2);
    assert.equal(await factorsOf(admin.id), 1);
  });

  test("anon and authenticated cannot end sessions or write a session-ending audit", async () => {
    const sessions = await sessionsOf(admin.id);
    const audit = await auditOf(admin.id);
    for (const token of [null, bystanderToken]) {
      const response = await rest(s.env, token, "POST", "rpc/platform_end_user_sessions", {
        p_user_id: admin.id, p_reason: REASON,
      });
      assert.equal(response.status, token ? 403 : 401);
      assert.equal(response.body.code, "42501", "function permission denied");
    }
    assert.equal(await sessionsOf(admin.id), sessions);
    assert.deepEqual(await auditOf(admin.id), audit);
  });

  test("partial failure: if sessions cannot be ended, no factor is removed and the audit says so (exit 5)", async () => {
    const sessionsBefore = await sessionsOf(admin.id);
    await s.db.query(`
      create function public.test_fail_sessions_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'platform.sessions_ended' and new.metadata->>'user_id' = '${admin.id}' then
          raise exception 'audit insert failed (rehearsal)';
        end if;
        return new;
      end $$;
      create trigger test_fail_sessions_audit before insert on public.platform_audit_log
        for each row execute function public.test_fail_sessions_audit();`);
    let result: { code: number; lines: string[] };
    try {
      result = await removeMfa();
    } finally {
      await s.db.query("drop trigger test_fail_sessions_audit on public.platform_audit_log; drop function public.test_fail_sessions_audit();");
    }
    assert.equal(result.code, 5, result.lines.join("\n"));
    assert.match(result.lines.at(-1)!, /^incomplete: session-ending outcome is unknown; no factor was removed/);
    assert.equal(await factorsOf(admin.id), 1, "factor kept");
    assert.equal(await sessionsOf(admin.id), sessionsBefore, "session deletion rolled back with its audit row");
    assert.equal((await rpc(device.access_token, "platform_status")).body.active, true, "nothing changed for the account");
    const audit = await auditOf(admin.id);
    assert.deepEqual(audit.map((a) => [a.action, a.metadata.outcome ?? null]), [
      ["platform.admin_granted", null], ["platform.mfa_removal_started", null], ["platform.mfa_removal_incomplete", "sessions_unknown"],
    ]);
    assert.equal(audit[2].metadata.operation_id, audit[1].metadata.operation_id);
    assert.deepEqual(audit[2].metadata.removed_factor_ids, []);
  });

  test("recovery: every session ends, old tokens and the app cookie are refused, others unaffected, audited", async () => {
    const { code, lines } = await removeMfa();
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.at(-1)!, /^ended \d+ session\(s\) and removed 1 factor\(s\)/);
    assert.equal(await factorsOf(admin.id), 0);
    assert.equal(await sessionsOf(admin.id), 0);
    assert.equal(await liveRefreshOf(admin.id), 0);

    for (const token of [device.access_token, secondDevice]) {
      assert.equal((await rpc(token, "platform_status")).status, 401);
      assert.equal((await rpc(token, "request_context")).status, 401);
      await assertAuthRejected(await authUser(token), "access");
    }
    await assertAuthRejected(await refresh(device.refresh_token), "refresh");
    const hijack = await fetch(`${s.env.apiUrl}/auth/v1/factors`, {
      method: "POST", headers: anonHeaders(device.access_token), body: JSON.stringify({ factor_type: "totp", friendly_name: "attacker" }),
    });
    await assertAuthRejected(hijack, "access");
    assert.equal(await factorsOf(admin.id), 0);
    const view = await me(adminCookie);
    assert.deepEqual([view.user, view.isPlatformAdmin], [null, false], "old app cookie is signed out");

    assert.equal((await rpc(bystanderToken, "request_context")).body.authenticated, true, "bystander token still works");
    assert.equal((await me(bystanderCookie)).user?.id, bystander.id, "bystander app session still works");
    assert.deepEqual(await realAccountsFingerprint(), georgeBefore, "George's account, password, MFA and sessions unchanged");

    const audit = (await auditOf(admin.id)).slice(3);
    assert.deepEqual(audit.map((a) => a.action), ["platform.mfa_removal_started", "platform.sessions_ended", "platform.mfa_factors_removed"]);
    assert.ok(audit.every((a) => a.reason === REASON && a.metadata.operation_id === audit[0].metadata.operation_id));
    assert.equal(audit[1].metadata.sessions_ended, 2);
    assert.deepEqual([audit[2].metadata.outcome, audit[2].metadata.sessions_ended, audit[2].metadata.remaining_factor_ids],
      ["complete", audit[1].metadata.sessions_ended, []]);
  });

  test("re-enrolment: password sign-in is AAL1 without platform access; a new authenticator restores it", async () => {
    const fresh = await passwordToken(s.env, admin);
    const before = (await rpc(fresh, "platform_status")).body;
    assert.deepEqual([before.listed, before.active], [true, false]);
    const reenrolled = await enrolAal2(fresh);
    assert.equal((await rpc(reenrolled.access_token, "platform_status")).body.active, true);
    assert.equal(await factorsOf(admin.id), 1);
  });

  test("standalone end-sessions preserves password and MFA while invalidating the prior session", async () => {
    const device = await enrolAal2(await passwordToken(s.env, bystander));
    const fingerprint = async () => (await s.db.query(`select
      (select md5(encrypted_password) from auth.users where id = $1) password,
      (select md5(coalesce(jsonb_agg(to_jsonb(f) order by f.id)::text, '[]')) from auth.mfa_factors f where user_id = $1) factors`, [bystander.id])).rows[0];
    const before = await fingerprint();
    const { code } = await operator("end-sessions", bystander);
    assert.equal(code, 0);
    assert.equal(await sessionsOf(bystander.id), 0);
    assert.deepEqual(await fingerprint(), before);
    await assertAuthRejected(await authUser(device.access_token), "access");
    await assertAuthRejected(await refresh(device.refresh_token), "refresh");
    assert.equal((await rpc(await passwordToken(s.env, bystander), "request_context")).body.authenticated, true, "original password still works");
    assert.equal(await factorsOf(bystander.id), 1);
    const rows = await auditOf(bystander.id);
    assert.equal(rows.at(-1)?.action, "platform.sessions_ended");
    assert.equal(rows.at(-1)?.reason, REASON);
    assert.deepEqual(await realAccountsFingerprint(), georgeBefore);
  });
});

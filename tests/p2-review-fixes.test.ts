// Regression tests for the P2 review findings: server-only audit outcomes (1), explicit handling of
// audit-completion failures with recoverable pending requests (2), refreshed session cookies reaching
// the browser (3), and JSON body shape/type validation (4). Runs the route handlers against a local
// fake Supabase (tests/helpers/fake-supabase.ts); nothing leaves 127.0.0.1.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { GET as getMe } from "../src/app/api/auth/me/route";
import { POST as postLogin } from "../src/app/api/auth/login/route";
import { GET as getWorkspaces } from "../src/app/api/workspaces/route";
import { POST as postActive } from "../src/app/api/workspaces/active/route";
import { GET as getTenantConfig } from "../src/app/api/tenant/config/route";
import { DELETE as deleteLogo, POST as recoverLogo, PUT as putLogo } from "../src/app/api/platform/workspace-logo/route";

const ENV_KEYS = [
  "AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL", "AUTH_OWNER_PASSWORD", "AUTH_ALLOW_MEMORY_SESSIONS", "VERCEL_ENV", "AUTH_FAIL_CLOSED",
];
const WS = "00000000-0000-4000-8000-0000000000aa";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

const admin: FakeUser = { id: "00000000-0000-4000-8000-0000000000a1", email: "admin@example.invalid", name: "Platform Admin" };
const otherAdmin: FakeUser = { id: "00000000-0000-4000-8000-0000000000a2", email: "admin2@example.invalid", name: "Other Admin" };
const member: FakeUser = { id: "00000000-0000-4000-8000-0000000000b1", email: "member@example.invalid", name: "Member" };
const outsider: FakeUser = { id: "00000000-0000-4000-8000-0000000000c1", email: "outsider@example.invalid", name: "Outsider" };

const workspace = { id: WS, name: "A", slug: "a", status: "active" };
const platformCtx = (u: FakeUser, mode: "read" | "write" | null) => ({
  authenticated: true, user_id: u.id, is_platform_admin: true, workspace: mode ? workspace : null, role: null,
  grant: mode ? { id: "00000000-0000-4000-8000-0000000000f1", mode, expires_at: "2099-01-01T00:00:00Z" } : null,
  permissions: mode ? ["dashboard.read"] : [],
});
const memberCtx = (u: FakeUser) => ({
  authenticated: true, user_id: u.id, is_platform_admin: false, workspace, role: "owner", grant: null,
  permissions: ["dashboard.read", "settings.read", "settings.write"],
});

function req(path: string, init: { cookie?: string; method?: string; body?: string | Buffer; contentType?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", init.contentType ?? "application/json");
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: init.method ?? "GET", headers, body: init.body });
}

function sessionSetCookies(res: Response): string[] {
  return res.headers.getSetCookie().filter((c) => c.startsWith("sb-127-auth-token"));
}

function sessionFromSetCookie(setCookies: string[]): { access_token: string; refresh_token: string } {
  const value = setCookies.map((c) => c.split(";")[0].split("=").slice(1).join("=")).join("");
  return JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8"));
}

let fake: FakeSupabase;
let restoreEnv: () => void;

beforeEach(async () => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  restoreEnv = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  fake = await startFakeSupabase();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AUTH_PROVIDER = "supabase";
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_ANON_KEY = fake.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = fake.serviceKey;
  fake.contexts.set(admin.id, platformCtx(admin, "write"));
  fake.contexts.set(otherAdmin.id, platformCtx(otherAdmin, "write"));
  fake.contexts.set(member.id, memberCtx(member));
});

afterEach(async () => {
  restoreEnv();
  await fake.close();
});

describe("finding 3: refreshed session cookies are applied to responses", () => {
  test("/api/auth/me with an expired access token and a valid refresh token returns the user and the new cookie", async () => {
    const old = fake.issue(member, { expired: true });
    const res = await getMe(req("/api/auth/me", { cookie: fake.cookie(old) }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user?.id, member.id);
    assert.equal(fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")).length, 1, "one refresh");
    const set = sessionSetCookies(res);
    assert.ok(set.length >= 1, "the refreshed session is sent to the browser");
    for (const c of set) assert.match(c, /HttpOnly/i);
    const fresh = sessionFromSetCookie(set);
    assert.notEqual(fresh.access_token, old.access_token);
    assert.notEqual(fresh.refresh_token, old.refresh_token);

    // The browser's next request uses the new cookie without another refresh.
    const again = await getMe(req("/api/auth/me", { cookie: `sb-127-auth-token=${set[0].split(";")[0].split("=").slice(1).join("=")}` }));
    assert.equal((await again.json()).user?.id, member.id);
    assert.equal(fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")).length, 1, "no second refresh");
  });

  test("an expired access token with an invalid refresh token: signed out, and the stale cookie is cleared", async () => {
    const old = fake.issue(member, { expired: true });
    const res = await getMe(req("/api/auth/me", { cookie: fake.cookie({ ...old, refresh_token: "not-a-refresh-token" }) }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user, null);
    const set = sessionSetCookies(res);
    assert.ok(set.length >= 1, "the stale session cookie is removed");
    for (const c of set) assert.match(c, /Max-Age=0/i);
  });

  test("route handlers and their denial responses carry the refreshed cookie too", async () => {
    const list = await getWorkspaces(req("/api/workspaces", { cookie: fake.cookie(fake.issue(member, { expired: true })) }));
    assert.equal(list.status, 200);
    assert.ok(sessionSetCookies(list).length >= 1, "/api/workspaces");

    const denied = await getTenantConfig(req("/api/tenant/config", { cookie: fake.cookie(fake.issue(outsider, { expired: true })) }));
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "no_active_workspace");
    assert.ok(sessionSetCookies(denied).length >= 1, "a 403 still delivers the refreshed session");

    const switched = await postActive(req("/api/workspaces/active", {
      method: "POST", cookie: fake.cookie(fake.issue(member, { expired: true })), body: JSON.stringify({ workspaceId: WS }) }));
    assert.equal(switched.status, 403);
    assert.ok(sessionSetCookies(switched).length >= 1, "/api/workspaces/active error path");
  });
});

describe("findings 1 and 2: server-controlled audit outcomes and explicit completion failures", () => {
  const put = (cookie: string) =>
    putLogo(req("/api/platform/workspace-logo", { method: "PUT", cookie, body: PNG, contentType: "image/png" }));
  const recover = (cookie: string, body: string) =>
    recoverLogo(req("/api/platform/workspace-logo", { method: "POST", cookie, body }));
  const finishCalls = () => fake.rpcCalls("platform_storage_change_finished");

  test("the outcome is recorded with the service role only, from the Storage state; the client never supplies it", async () => {
    const res = await put(fake.cookie(fake.issue(admin)));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, requestId: body.requestId, outcome: "succeeded", objectPath: `${WS}/logo.png` });
    assert.equal(finishCalls().length, 1);
    for (const c of finishCalls()) {
      assert.equal(c.bearer, fake.serviceKey, "completion runs as the service role");
      assert.deepEqual(Object.keys(c.body as object).sort(), ["p_actor_id", "p_request_id"], "no outcome flag is sent");
      assert.equal((c.body as { p_actor_id: string }).p_actor_id, admin.id, "actor comes from the verified context");
    }
    for (const c of fake.rpcCalls("platform_storage_change_requested")) assert.notEqual(c.bearer, fake.serviceKey, "requests use the user's JWT");
    assert.deepEqual(fake.rpcCalls("platform_storage_change_claimed").map((c) => c.bearer), [fake.serviceKey], "claimed by the server");
  });

  test("a request made by calling the RPC directly (never claimed by the server) can never get an outcome", async () => {
    const session = fake.issue(admin);
    const direct = await fetch(`${fake.url}/rest/v1/rpc/platform_storage_change_requested`, {
      method: "POST",
      headers: { apikey: fake.anonKey, Authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ p_operation: "upsert", p_object_path: `${WS}/logo.png` }),
    });
    const spoofId = await direct.json();
    assert.equal((await put(fake.cookie(session))).status, 200, "a real change happens meanwhile");
    const res = await recover(fake.cookie(session), JSON.stringify({ requestId: spoofId }));
    assert.deepEqual([res.status, (await res.json()).code], [404, "not_found"]);
    assert.equal(fake.requests.get(spoofId)?.outcome, undefined);
  });

  test("a failed Storage write is reported from the database outcome (502 storage_failed), not as success", async () => {
    fake.faults.uploadFails = true;
    const res = await put(fake.cookie(fake.issue(admin)));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.deepEqual([body.code, body.outcome], ["storage_failed", "failed"]);
    assert.equal(fake.requests.get(body.requestId)?.outcome, "failed");
  });

  test("a transient completion failure is retried and the change is confirmed", async () => {
    fake.faults.finishFailures = 1;
    const res = await put(fake.cookie(fake.issue(admin)));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).outcome, "succeeded");
    assert.equal(finishCalls().length, 2);
  });

  test("persistent completion failure: explicit 503 audit_pending, request preserved, recovered later exactly once", async () => {
    fake.faults.finishFailures = 99;
    const cookie = fake.cookie(fake.issue(admin));
    const res = await put(cookie);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "audit_pending");
    assert.ok(Number.isSafeInteger(body.requestId));
    assert.equal(finishCalls().length, 3, "three attempts before giving up");
    assert.equal(fake.objects.has(`${WS}/logo.png`), true, "the write happened");
    assert.equal(fake.requests.get(body.requestId)?.outcome, undefined, "the request stays pending, not lost or guessed");

    const objectsBefore = [...fake.objects.entries()];
    const blocked = await put(cookie);
    assert.deepEqual([blocked.status, (await blocked.json()).code], [409, "change_pending"], "no new change while one is pending");
    assert.deepEqual([...fake.objects.entries()], objectsBefore, "the blocked change wrote nothing");

    const stillDown = await recover(cookie, JSON.stringify({ requestId: body.requestId }));
    assert.equal(stillDown.status, 503);
    assert.equal((await stillDown.json()).code, "audit_pending");

    fake.faults.finishFailures = 0;
    const recovered = await recover(cookie, JSON.stringify({ requestId: body.requestId }));
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { ok: true, requestId: body.requestId, outcome: "succeeded" });
    const retried = await recover(cookie, JSON.stringify({ requestId: body.requestId }));
    assert.deepEqual(await retried.json(), { ok: true, requestId: body.requestId, outcome: "succeeded" }, "idempotent");
    assert.equal((await put(cookie)).status, 200, "after recovery, changes are possible again");
  });

  test("recovery survives the grant ending, but only for the requesting platform admin", async () => {
    fake.faults.finishFailures = 99;
    const res = await put(fake.cookie(fake.issue(admin)));
    const { requestId } = await res.json();
    fake.faults.finishFailures = 0;

    const otherRes = await recover(fake.cookie(fake.issue(otherAdmin)), JSON.stringify({ requestId }));
    assert.deepEqual([otherRes.status, (await otherRes.json()).code], [404, "not_found"]);
    const memberRes = await recover(fake.cookie(fake.issue(member)), JSON.stringify({ requestId }));
    assert.deepEqual([memberRes.status, (await memberRes.json()).code], [403, "forbidden"]);
    const unknown = await recover(fake.cookie(fake.issue(admin)), JSON.stringify({ requestId: 424242 }));
    assert.equal(unknown.status, 404);

    fake.contexts.set(admin.id, platformCtx(admin, null));
    const ok = await recover(fake.cookie(fake.issue(admin)), JSON.stringify({ requestId }));
    assert.equal(ok.status, 200, "no live grant needed to record what already happened");
  });

  test("if the request cannot be audited first, nothing is written", async () => {
    fake.faults.requestedFails = true;
    const res = await put(fake.cookie(fake.issue(admin)));
    assert.deepEqual([res.status, (await res.json()).code], [503, "unavailable"]);
    assert.equal(fake.objects.size, 0);
    assert.equal(finishCalls().length, 0);
  });

  test("delete is audited the same way", async () => {
    const cookie = fake.cookie(fake.issue(admin));
    assert.equal((await put(cookie)).status, 200);
    const del = await deleteLogo(req("/api/platform/workspace-logo?ext=png", { method: "DELETE", cookie }));
    assert.equal(del.status, 200);
    assert.equal((await del.json()).outcome, "succeeded");
    const again = await deleteLogo(req("/api/platform/workspace-logo?ext=png", { method: "DELETE", cookie }));
    assert.deepEqual([again.status, (await again.json()).outcome], [502, "failed"], "deleting an absent logo is not a success");
  });
});

describe("finding 4: JSON bodies must be objects with correctly typed fields", () => {
  const NON_OBJECTS = ["null", "[]", "[{}]", "42", "\"text\"", "true", "{not json", ""];

  test("login (supabase): non-objects and wrongly typed fields are 400 validation_failed, never a crash or an Auth call", async () => {
    const bodies = [
      ...NON_OBJECTS,
      JSON.stringify({ email: 123, password: "x" }),
      JSON.stringify({ email: "a@example.invalid", password: {} }),
      JSON.stringify({ email: ["a@example.invalid"], password: "x" }),
      JSON.stringify({ email: null, password: "x" }),
      JSON.stringify({ email: "a@example.invalid", password: 12345678 }),
      JSON.stringify({ email: { $ne: "" }, password: "x" }),
    ];
    for (const body of bodies) {
      const res = await postLogin(req("/api/auth/login", { method: "POST", body }));
      assert.equal(res.status, 400, body);
      assert.equal((await res.json()).code, "validation_failed", body);
    }
    assert.equal(fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")).length, 0);
  });

  test("login (legacy): the same bodies are 400, not an unhandled exception", async () => {
    process.env.AUTH_PROVIDER = "legacy";
    process.env.AUTH_SECRET = "legacy-secret-for-test-only-0123456789";
    process.env.AUTH_OWNER_EMAIL = "owner@example.invalid";
    process.env.AUTH_OWNER_PASSWORD = "owner-password-for-test-only";
    process.env.AUTH_ALLOW_MEMORY_SESSIONS = "true";
    for (const body of [...NON_OBJECTS, JSON.stringify({ email: 1, password: [] })]) {
      const res = await postLogin(req("/api/auth/login", { method: "POST", body }));
      assert.equal(res.status, 400, body);
    }
  });

  test("workspace switch: non-objects and non-string workspaceId are 422 and never reach the database", async () => {
    const cookie = fake.cookie(fake.issue(member));
    const bodies = [
      ...NON_OBJECTS,
      JSON.stringify({ workspaceId: 123 }),
      JSON.stringify({ workspaceId: null }),
      JSON.stringify({ workspaceId: [WS] }),
      JSON.stringify({ workspaceId: { id: WS } }),
      JSON.stringify({ workspace_id: WS }),
    ];
    for (const body of bodies) {
      const res = await postActive(req("/api/workspaces/active", { method: "POST", cookie, body }));
      assert.equal(res.status, 422, body);
      assert.equal((await res.json()).code, "validation_failed", body);
    }
    assert.equal(fake.rpcCalls("switch_workspace").length, 0);
  });

  test("logo recovery: requestId must be a positive safe integer", async () => {
    const cookie = fake.cookie(fake.issue(admin));
    const bodies = [
      ...NON_OBJECTS,
      JSON.stringify({ requestId: "1001" }),
      JSON.stringify({ requestId: 0 }),
      JSON.stringify({ requestId: -1 }),
      JSON.stringify({ requestId: 1.5 }),
      JSON.stringify({ requestId: null }),
      JSON.stringify({ requestId: [1001] }),
      JSON.stringify({ requestId: 9007199254740993 }),
    ];
    for (const body of bodies) {
      const res = await recoverLogo(req("/api/platform/workspace-logo", { method: "POST", cookie, body }));
      assert.equal(res.status, 422, body);
      assert.equal((await res.json()).code, "validation_failed", body);
    }
    assert.equal(fake.rpcCalls("platform_storage_change_finished").length, 0);
  });
});

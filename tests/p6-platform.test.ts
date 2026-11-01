// P6 platform administration (spec §7.5, §5.3): request validation, the denial matrix (no session,
// non-admin, listed admin with an AAL1 session, legacy mode), reasons on sensitive actions, credential
// hygiene, and static guards, against the local fake Supabase (tests/helpers/fake-supabase.ts; nothing
// leaves 127.0.0.1). Database enforcement runs against PGlite (tests/db/p6-platform-console.test.ts)
// and the whole console, including MFA, against the real local Supabase stack.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { startFakeSupabase, type FakeSupabase, type FakeUser } from "./helpers/fake-supabase";
import { accessBody, auditQuery, grantsQuery, provisionBody, reasonBody, safeMetadata, workspaceQuery } from "../src/lib/platform/console";
import { mfaFailure, verifyBody } from "../src/lib/auth/mfa";
import { middleware } from "../src/middleware";
import { GET as searchRoute, POST as provisionRoute } from "../src/app/api/platform/workspaces/route";
import { GET as detailRoute } from "../src/app/api/platform/workspaces/[id]/route";
import { POST as suspendRoute } from "../src/app/api/platform/workspaces/[id]/suspend/route";
import { POST as reactivateRoute } from "../src/app/api/platform/workspaces/[id]/reactivate/route";
import { POST as accessRoute } from "../src/app/api/platform/workspaces/[id]/access/route";
import { POST as rotateRoute } from "../src/app/api/platform/workspaces/[id]/bootstrap-invitation/route";
import { GET as wsAuditRoute } from "../src/app/api/platform/workspaces/[id]/audit/route";
import { GET as auditRoute } from "../src/app/api/platform/audit/route";
import { GET as grantsRoute } from "../src/app/api/platform/access/route";
import { DELETE as revokeRoute } from "../src/app/api/platform/access/[grantId]/route";
import { GET as mfaStatusRoute } from "../src/app/api/auth/mfa/route";
import { POST as mfaEnrollRoute } from "../src/app/api/auth/mfa/enroll/route";
import { POST as mfaVerifyRoute } from "../src/app/api/auth/mfa/verify/route";

const ROOT = join(__dirname, "..");
const ENV_KEYS = [
  "AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL", "AUTH_OWNER_PASSWORD", "AUTH_ALLOW_MEMORY_SESSIONS", "VERCEL_ENV", "AUTH_FAIL_CLOSED",
];
const WS = "00000000-0000-4000-8000-0000000060a0";
const WS_B = "00000000-0000-4000-8000-0000000060b0";
const GRANT = "00000000-0000-4000-8000-0000000060c0";
const REASON = "Customer asked for help with setup";
const admin: FakeUser = { id: "00000000-0000-4000-8000-0000000060a1", email: "admin@example.invalid", name: "Platform Admin" };
const member: FakeUser = { id: "00000000-0000-4000-8000-0000000060a2", email: "member@example.invalid", name: "Member" };

// Route handlers type their own params; tests pass them as a plain record.
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;
const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });

function req(path: string, init: { cookie?: string; method?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, true, `should accept ${JSON.stringify(value)}`);
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, `should reject ${JSON.stringify(value)}`);

// [method, path, handler, params, body, sensitive]
const ROUTES: [string, string, Handler, Record<string, string>, unknown, boolean][] = [
  ["GET", "/api/platform/workspaces", searchRoute as Handler, {}, undefined, false],
  ["POST", "/api/platform/workspaces", provisionRoute as Handler, {}, { provisioningKey: "acme-1", name: "Acme", slug: "acme", ownerEmail: "o@example.invalid" }, true],
  ["GET", `/api/platform/workspaces/${WS}`, detailRoute as Handler, { id: WS }, undefined, false],
  ["POST", `/api/platform/workspaces/${WS}/suspend`, suspendRoute as Handler, { id: WS }, { reason: REASON }, true],
  ["POST", `/api/platform/workspaces/${WS}/reactivate`, reactivateRoute as Handler, { id: WS }, { reason: REASON }, true],
  ["POST", `/api/platform/workspaces/${WS}/access`, accessRoute as Handler, { id: WS }, { mode: "read", reason: REASON, durationMinutes: 30 }, true],
  ["POST", `/api/platform/workspaces/${WS}/bootstrap-invitation`, rotateRoute as Handler, { id: WS }, { reason: REASON }, true],
  ["GET", `/api/platform/workspaces/${WS}/audit`, wsAuditRoute as Handler, { id: WS }, undefined, false],
  ["GET", "/api/platform/audit", auditRoute as Handler, {}, undefined, false],
  ["GET", "/api/platform/access", grantsRoute as Handler, {}, undefined, false],
  ["DELETE", `/api/platform/access/${GRANT}`, revokeRoute as Handler, { grantId: GRANT }, { reason: REASON }, true],
];
const MFA_ROUTES: [string, string, Handler, unknown][] = [
  ["GET", "/api/auth/mfa", mfaStatusRoute as unknown as Handler, undefined],
  ["POST", "/api/auth/mfa/enroll", mfaEnrollRoute as unknown as Handler, undefined],
  ["POST", "/api/auth/mfa/verify", mfaVerifyRoute as unknown as Handler, { factorId: GRANT, code: "123456" }],
];
const call = (route: (typeof ROUTES)[number], cookie?: string, body?: unknown) =>
  route[2](req(route[1], { method: route[0], cookie, body: body === undefined ? route[4] : body }), params(route[3]));
const WRITE_RPCS = ["platform_provision_workspace", "platform_suspend_workspace", "platform_reactivate_workspace",
  "platform_grant_access", "platform_rotate_bootstrap_invitation", "platform_revoke_access"];

// ---------------------------------------------------------------------------
describe("P6 validation (zod, strict)", () => {
  test("sensitive actions need a reason of 10–500 characters (trimmed); nothing else is accepted", () => {
    ok(reasonBody, { reason: REASON });
    assert.deepEqual(reasonBody.parse({ reason: `  ${REASON}  ` }), { reason: REASON });
    for (const v of [{}, { reason: null }, { reason: "too short" }, { reason: "x" }, { reason: "x".repeat(501) },
      { reason: "   short   " }, { reason: REASON, workspaceId: WS_B }, { reason: REASON, actor: admin.id }]) {
      bad(reasonBody, v);
    }
  });

  test("provisioning: key, business name, slug, and owner email are required and checked", () => {
    const base = { provisioningKey: "acme-2026", name: "Acme Roofing", slug: "acme-roofing", ownerEmail: "Owner@Example.INVALID" };
    ok(provisionBody, base);
    assert.equal(provisionBody.parse(base).ownerEmail, "owner@example.invalid");
    assert.equal(provisionBody.parse({ ...base, slug: "ACME-Roofing" }).slug, "acme-roofing");
    for (const v of [{ ...base, provisioningKey: "x" }, { ...base, provisioningKey: "has space" }, { ...base, name: "" },
      { ...base, slug: "-acme" }, { ...base, slug: "ac" }, { ...base, slug: "acme_roofing" }, { ...base, slug: "a".repeat(49) },
      { ...base, ownerEmail: "nope" }, { ...base, status: "active" }, { ...base, ownerUserId: admin.id }]) {
      bad(provisionBody, v);
    }
  });

  test("support access: read or write, a reason, and 1–480 whole minutes", () => {
    ok(accessBody, { mode: "read", reason: REASON, durationMinutes: 1 });
    ok(accessBody, { mode: "write", reason: REASON, durationMinutes: 480 });
    for (const v of [{ mode: "admin", reason: REASON, durationMinutes: 30 }, { mode: "read", reason: "short", durationMinutes: 30 },
      { mode: "read", reason: REASON, durationMinutes: 0 }, { mode: "read", reason: REASON, durationMinutes: 481 },
      { mode: "read", reason: REASON, durationMinutes: 1.5 }, { mode: "read", reason: REASON, durationMinutes: "30" },
      { mode: "read", reason: REASON }, { mode: "read", reason: REASON, durationMinutes: 30, expiresAt: "2099-01-01" }]) {
      bad(accessBody, v);
    }
  });

  test("queries: search text, status filter, page size, cursor, and grant scope are bounded", () => {
    ok(workspaceQuery, { q: "acme", status: "suspended", limit: "100" });
    for (const v of [{ q: "x".repeat(101) }, { status: "deleted" }, { limit: "101" }, { limit: "0" }, { cursor: "x".repeat(501) }, { order: "name" }]) {
      bad(workspaceQuery, v);
    }
    ok(auditQuery, { limit: "20" });
    bad(auditQuery, { action: "workspace.suspended" });
    assert.equal(grantsQuery.parse({}).include, "active");
    bad(grantsQuery, { include: "expired" });
  });

  test("MFA: a factor id and a 6-digit code; GoTrue failures map to 422 / 429 / 503", () => {
    ok(verifyBody, { factorId: GRANT, code: " 123456 " });
    for (const v of [{ factorId: GRANT, code: "12345" }, { factorId: GRANT, code: "1234567" }, { factorId: GRANT, code: "12a456" },
      { factorId: "nope", code: "123456" }, { factorId: GRANT, code: "123456", secret: "x" }]) {
      bad(verifyBody, v);
    }
    assert.deepEqual([mfaFailure({ status: 422, code: "mfa_verification_failed" }).status, mfaFailure({ status: 422 }).code], [422, "validation_failed"]);
    assert.equal(mfaFailure({ status: 400, code: "mfa_challenge_expired" }).status, 422);
    assert.deepEqual([mfaFailure({ status: 429 }).status, mfaFailure({ status: 429 }).code], [429, "rate_limited"]);
    assert.deepEqual([mfaFailure({ status: 500 }).status, mfaFailure(null).status], [503, 503]);
  });

  test("audit metadata never carries anything that looks like a credential", () => {
    assert.deepEqual(safeMetadata({ invitation_id: "i", invite_token: "t", token_hash: "h", client_secret: "s", password: "p", mode: "read" }),
      { invitation_id: "i", mode: "read" });
    assert.deepEqual(safeMetadata(null), {});
  });
});

// ---------------------------------------------------------------------------
describe("P6 routes (AUTH_PROVIDER=supabase, fake Supabase)", () => {
  let fake: FakeSupabase;
  let restoreEnv: () => void;
  const cookie = (u: FakeUser) => fake.cookie(fake.issue(u));
  const status = (listed: boolean, aal: "aal1" | "aal2") => {
    fake.rpc.platform_status = (_a, c) => c.userId
      ? { status: 200, body: { listed, aal, active: listed && aal === "aal2" } }
      : { status: 401, body: { code: "42501", message: "permission denied" } };
  };
  const adminContext = () => fake.contexts.set(admin.id, {
    authenticated: true, user_id: admin.id, is_platform_admin: true, workspace: null, role: null, grant: null, permissions: [],
  });
  const writes = () => fake.calls.filter((c) => WRITE_RPCS.some((n) => c.path === `/rest/v1/rpc/${n}`));

  beforeEach(async () => {
    const prev: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) prev[k] = process.env[k];
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
  });

  afterEach(async () => {
    await fake.close();
    restoreEnv();
  });

  test("all 11 console handlers and the 3 MFA handlers refuse a request without a session (401)", async () => {
    assert.equal(ROUTES.length, 11);
    for (const route of ROUTES) {
      const r = await json(await call(route));
      assert.deepEqual([r.status, r.body.code], [401, "unauthenticated"], `${route[0]} ${route[1]}`);
    }
    for (const [method, path, handler, body] of MFA_ROUTES) {
      const r = await json(await handler(req(path, { method, body }), params()));
      assert.deepEqual([r.status, r.body.code], [401, "unauthenticated"], `${method} ${path}`);
    }
  });

  test("a workspace member who is not a platform admin is refused everywhere (403 forbidden), MFA included", async () => {
    status(false, "aal1");
    const c = cookie(member);
    for (const route of ROUTES) {
      const r = await json(await call(route, c));
      assert.deepEqual([r.status, r.body.code], [403, "forbidden"], `${route[0]} ${route[1]}`);
    }
    for (const [method, path, handler, body] of MFA_ROUTES) {
      const r = await json(await handler(req(path, { method, cookie: c, body }), params()));
      assert.deepEqual([r.status, r.body.code], [403, "forbidden"], `${method} ${path}`);
    }
    assert.deepEqual(writes(), []);
    assert.equal(fake.calls.some((x) => x.path.startsWith("/auth/v1/factors")), false, "no MFA call for a non-admin");
  });

  test("a listed platform admin with a password-only (AAL1) session gets mfa_required and nothing runs", async () => {
    status(true, "aal1");
    const c = cookie(admin);
    for (const route of ROUTES) {
      const r = await json(await call(route, c));
      assert.deepEqual([r.status, r.body.code], [403, "mfa_required"], `${route[0]} ${route[1]}`);
    }
    const rpcs = new Set(fake.calls.filter((x) => x.path.startsWith("/rest/v1/rpc/")).map((x) => x.path));
    assert.deepEqual([...rpcs].sort(), ["/rest/v1/rpc/platform_status", "/rest/v1/rpc/request_context"]);
  });

  test("sensitive actions without a valid reason, malformed ids, and unknown keys are 422 before any write", async () => {
    adminContext();
    status(true, "aal2");
    const c = cookie(admin);
    for (const route of ROUTES.filter((r) => r[5] && r[1] !== "/api/platform/workspaces")) {
      const base = route[4] as Record<string, unknown>;
      for (const body of [{ ...base, reason: undefined }, { ...base, reason: "too short" }, "{not json"]) {
        const r = await json(await call(route, c, body));
        assert.deepEqual([r.status, r.body.code], [422, "validation_failed"], `${route[0]} ${route[1]} ${JSON.stringify(body)}`);
      }
    }
    const malformed: [Response, string][] = [
      [await (suspendRoute as Handler)(req("/api/platform/workspaces/1;drop/suspend", { method: "POST", cookie: c, body: { reason: REASON } }), params({ id: "1;drop" })), "id"],
      [await (revokeRoute as Handler)(req("/api/platform/access/nope", { method: "DELETE", cookie: c, body: { reason: REASON } }), params({ grantId: "nope" })), "grantId"],
      [await call(ROUTES[1], c, { provisioningKey: "acme-1", name: "Acme", slug: "acme", ownerEmail: "o@example.invalid", status: "active" }), "unknown key"],
      [await call(ROUTES[5], c, { mode: "read", reason: REASON, durationMinutes: 481 }), "duration"],
      [await (searchRoute as Handler)(req("/api/platform/workspaces?limit=1000", { cookie: c }), params()), "limit"],
      [await (searchRoute as Handler)(req("/api/platform/workspaces?cursor=garbage", { cookie: c }), params()), "cursor"],
      [await (auditRoute as Handler)(req("/api/platform/audit?select=*", { cookie: c }), params()), "unknown query key"],
    ];
    for (const [res, label] of malformed) {
      const body = (await res.json()) as { code: string; fields?: Record<string, string> };
      assert.deepEqual([res.status, body.code], [422, "validation_failed"], label);
      assert.ok(body.fields && Object.keys(body.fields).length > 0, `${label}: fields present`);
    }
    assert.deepEqual(writes(), [], "no write reached the database");
  });

  test("the target workspace comes from the path only: a workspace id in the body never reaches the database", async () => {
    adminContext();
    status(true, "aal2");
    const seen: Record<string, unknown>[] = [];
    fake.rpc.platform_suspend_workspace = (a) => { seen.push(a); return { status: 204, body: null }; };
    fake.rpc.platform_get_workspace = () => ({ status: 200, body: { id: WS, name: "A", slug: "a", status: "suspended", created_at: "2031-01-01T00:00:00Z",
      suspended_at: "2031-01-02T00:00:00Z", suspended_reason: REASON, bootstrap_owner_email: "o@example.invalid", owner_acquired_at: null,
      members: { owner: 0, admin: 0, employee: 0 }, open_owner_invitation: null, can_rotate_bootstrap: true } });
    const r = await json(await call(ROUTES[3], cookie(admin), { reason: REASON, workspaceId: WS_B, workspace_id: WS_B }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(seen, [{ p_workspace_id: WS, p_reason: REASON }]);
  });

  test("provisioning returns the owner link once (built on this app's origin); a repeat gets no link; nothing stored is echoed", async () => {
    adminContext();
    status(true, "aal2");
    let created = true;
    fake.rpc.platform_provision_workspace = () => ({ status: 200, body: { workspace_id: WS, created, invitation_id: GRANT,
      invite_token: created ? "tok_fresh_once" : null } });
    const first = await json(await call(ROUTES[1], cookie(admin)));
    assert.deepEqual(first.body, { ok: true, workspaceId: WS, created: true, inviteUrl: "http://localhost:3000/invite/tok_fresh_once" });
    created = false;
    const again = await json(await call(ROUTES[1], cookie(admin)));
    assert.deepEqual(again.body, { ok: true, workspaceId: WS, created: false, inviteUrl: null });
    assert.equal(JSON.stringify(again.body).includes(GRANT), false, "no invitation id either");
  });

  test("database refusals keep their meaning: conflict 409, not found 404, suspended 423, refused 403, failure 503", async () => {
    adminContext();
    status(true, "aal2");
    const c = cookie(admin);
    const cases: [Record<string, unknown>, number, string][] = [
      [{ code: "23505", message: "conflict" }, 409, "conflict"],
      [{ code: "P0002", message: "not_found" }, 404, "not_found"],
      [{ code: "P0001", message: "workspace_suspended" }, 423, "workspace_suspended"],
      [{ code: "42501", message: "forbidden" }, 403, "forbidden"],
      [{ code: "XX000", message: "boom" }, 503, "unavailable"],
    ];
    for (const [err, httpStatus, code] of cases) {
      fake.rpc.platform_grant_access = () => ({ status: httpStatus === 503 ? 500 : 400, body: err });
      const r = await json(await call(ROUTES[5], c));
      assert.deepEqual([r.status, r.body.code], [httpStatus, code], JSON.stringify(err));
    }
  });

  test("middleware decides console pages before rendering: 404 for non-admins, MFA for AAL1 admins, pass for AAL2", async () => {
    const page = async (path: string, u: FakeUser) => middleware(req(path, { cookie: cookie(u) }));
    status(false, "aal1");
    for (const path of ["/platform", "/platform/audit", `/platform/workspaces/${WS}`, "/platform/mfa"]) {
      const r = await page(path, member);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers.get("location"), null, path);
    }
    status(true, "aal1");
    for (const path of ["/platform", `/platform/workspaces/${WS}`]) {
      const r = await page(path, admin);
      assert.deepEqual([r.status, new URL(r.headers.get("location")!).pathname], [307, "/platform/mfa"], path);
    }
    assert.equal((await page("/platform/mfa", admin)).status, 200);
    status(true, "aal2");
    assert.equal((await page("/platform", admin)).status, 200);
    const back = await page("/platform/mfa", admin);
    assert.deepEqual([back.status, new URL(back.headers.get("location")!).pathname], [307, "/platform"]);
    const signedOut = await middleware(req("/platform"));
    assert.deepEqual([signedOut.status, new URL(signedOut.headers.get("location")!).pathname], [307, "/login"]);
    fake.rpc.platform_status = () => ({ status: 500, body: { code: "XX000", message: "boom" } });
    assert.equal((await page("/platform", admin)).status, 503, "an unknown status is never treated as access");
  });

  test("audit pages drop credential-like metadata and use an opaque cursor", async () => {
    adminContext();
    status(true, "aal2");
    fake.rpc.platform_audit_page = () => ({ status: 200, body: [
      { id: 9, created_at: "2031-01-02T00:00:00Z", action: "invitation.rotated", reason: REASON, metadata: { invite_token: "t", token_hash: "h", invitation_id: "i" },
        workspace_id: WS, workspace_name: "A", actor_email: admin.email },
      { id: 7, created_at: "2031-01-01T00:00:00Z", action: "workspace.provisioned", reason: null, metadata: {}, workspace_id: WS, workspace_name: "A", actor_email: admin.email },
    ] });
    const r = await json(await (auditRoute as Handler)(req("/api/platform/audit?limit=1", { cookie: cookie(admin) }), params()));
    assert.equal(r.status, 200);
    const items = r.body.items as { metadata: Record<string, unknown>; actorEmail: string; reason: string }[];
    assert.deepEqual(items.map((i) => [i.metadata, i.actorEmail, i.reason]), [[{ invitation_id: "i" }, admin.email, REASON]]);
    assert.equal(typeof r.body.nextCursor, "string");
    const text = JSON.stringify(r.body);
    assert.equal(/token|hash/i.test(text.replace(/"nextCursor":"[^"]*"/, "")), false);
    const call2 = fake.rpcCalls("platform_audit_page")[0].body as Record<string, unknown>;
    assert.deepEqual(call2, { p_workspace_id: null, p_before_id: null, p_limit: 2 });
  });
});

describe("P6 legacy mode is unchanged", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AUTH_PROVIDER;
    process.env.AUTH_PROVIDER = "legacy";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = prev;
  });

  test("every platform console and MFA endpoint answers 404 in legacy mode", async () => {
    for (const route of ROUTES) assert.equal((await call(route)).status, 404, `${route[0]} ${route[1]}`);
    for (const [method, path, handler, body] of MFA_ROUTES) {
      assert.equal((await handler(req(path, { method, body }), params())).status, 404, `${method} ${path}`);
    }
  });

  test("console pages are 404 from middleware in legacy mode (the streamed page notFound() would arrive as a 200)", async () => {
    for (const path of ["/platform", "/platform/audit", `/platform/workspaces/${WS}`, "/platform/mfa"]) {
      const r = await middleware(req(path));
      assert.deepEqual([r.status, r.headers.get("location")], [404, null], path);
    }
  });
});

describe("P6 static guards", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  };
  const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
  const CONSOLE_ROUTES = walk(join(ROOT, "src", "app", "api", "platform"))
    .filter((f) => f.endsWith("route.ts") && !rel(f).includes("workspace-logo"));
  const MFA = walk(join(ROOT, "src", "app", "api", "auth", "mfa")).filter((f) => f.endsWith("route.ts"));
  const UI = [...walk(join(ROOT, "src", "components", "platform")), join(ROOT, "src", "components", "SupportAccess.tsx"),
    ...walk(join(ROOT, "src", "app", "(platform)"))];
  const LIBS = ["src/lib/api/platform.ts", "src/lib/platform/console.ts", "src/lib/platform/page.ts", "src/lib/auth/mfa.ts"].map((f) => join(ROOT, f));

  test("every console handler goes through platformApi; every mutation is sensitive and (except provisioning) needs a reason", () => {
    assert.equal(CONSOLE_ROUTES.length, 10);
    let mutations = 0;
    for (const f of CONSOLE_ROUTES) {
      const src = readFileSync(f, "utf8");
      const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\([^]*?\n\}/g)];
      assert.ok(handlers.length > 0, rel(f));
      for (const [body, method] of handlers) {
        assert.match(body, /return platformApi\(req, /, `${rel(f)} ${method}`);
        if (method === "GET") {
          assert.match(body, /platformApi\(req, \{\}/, `${rel(f)} GET is not marked sensitive`);
          continue;
        }
        mutations++;
        assert.match(body, /platformApi\(req, \{ sensitive: true \}/, `${rel(f)} ${method} re-checks the session`);
        assert.match(body, /parseBody\(req, (reasonBody|accessBody|provisionBody)\)/, `${rel(f)} ${method} validates its body`);
      }
    }
    assert.equal(mutations, 6);
  });

  test("platform code never uses the service role; MFA routes go through mfaApi", () => {
    for (const f of [...CONSOLE_ROUTES, ...MFA, ...LIBS, ...UI]) {
      assert.equal(/supabase\/admin|SERVICE_ROLE|serviceRole|createAdminClient/.test(readFileSync(f, "utf8")), false, `${rel(f)}: no service role`);
    }
    for (const f of MFA) assert.match(readFileSync(f, "utf8"), /return mfaApi\(req, /, rel(f));
  });

  test("the console UI never handles invitation tokens and sends a workspace id only to the spec's switch endpoint", () => {
    for (const f of UI) {
      const src = readFileSync(f, "utf8");
      assert.equal(/invite_?token|token_?hash/i.test(src), false, `${rel(f)}: no invitation tokens`);
      for (const m of src.matchAll(/JSON\.stringify\(\{[^)]*workspace_?id/gi)) {
        assert.match(src.slice(Math.max(0, m.index! - 120), m.index), /"\/api\/workspaces\/active"/, `${rel(f)}: workspace id only to /api/workspaces/active`);
      }
      assert.equal(/twilio|resend|sendgrid|nodemailer|mailto:|sms:/i.test(src), false, `${rel(f)}: nothing outbound`);
    }
  });

  test("the platform console has its own shell: no client sidebar, and the workspace pages are untouched", () => {
    const shell = readFileSync(join(ROOT, "src", "components", "platform", "PlatformShell.tsx"), "utf8");
    assert.equal(/Sidebar/.test(shell), false);
    const layout = readFileSync(join(ROOT, "src", "app", "(platform)", "layout.tsx"), "utf8");
    assert.match(layout, /notFound\(\)/, "legacy mode hides the console");
    const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
    assert.match(mw, /"\/platform\/:path\*"/);
  });
});

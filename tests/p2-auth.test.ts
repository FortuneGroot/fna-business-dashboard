// P2 authentication: provider switch, request-context evaluation, AUTH_PROVIDER=supabase routing
// without a live Supabase (no network), and static guards (service-role allowlist, no client
// workspace ids, local-only AAL1 override). Real GoTrue/PostgREST behaviour is covered by the stack suite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { NextRequest } from "next/server";
import { authProvider, supabaseAuthConfig, supabaseCookieOptions } from "../src/lib/auth/provider";
import {
  denialResponse,
  evaluateContext,
  legacyRoleOf,
  type RequestContext,
} from "../src/lib/authz/context";
import { PAGE_DENIAL_REDIRECT, pagePermission } from "../src/lib/authz/evaluate";
import { interpretAuthMeProbe } from "../src/lib/auth/auth-me-probe";
import { AUTH_COOKIE, authenticateCredentials, createSessionToken, resetAuthSessionsForTests } from "../src/lib/auth";
import { middleware } from "../src/middleware";
import { GET as getMe } from "../src/app/api/auth/me/route";
import { POST as postLogin } from "../src/app/api/auth/login/route";
import { POST as postLogout } from "../src/app/api/auth/logout/route";
import { GET as getTenantConfig } from "../src/app/api/tenant/config/route";
import { requireApiRole } from "../src/lib/auth/guards";
import { GET as getWorkspaces } from "../src/app/api/workspaces/route";
import { POST as postActive } from "../src/app/api/workspaces/active/route";
import { PUT as putLogo } from "../src/app/api/platform/workspace-logo/route";

const ROOT = join(__dirname, "..");
const ENV_KEYS = [
  "AUTH_PROVIDER", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_SECRET", "AUTH_OWNER_EMAIL", "AUTH_OWNER_PASSWORD", "AUTH_ALLOW_MEMORY_SESSIONS", "VERCEL_ENV", "AUTH_FAIL_CLOSED",
];
// Unreachable local port: any accidental network call fails fast instead of leaving the machine.
const DEAD_URL = "http://127.0.0.1:9";
const FAKE_ANON = "test-anon-key-not-a-secret";

function saveEnv() {
  const prev: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function req(path: string, init: { cookie?: string; method?: string; body?: unknown; contentType?: string } = {}) {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body !== undefined) headers.set("content-type", init.contentType ?? "application/json");
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "user@example.invalid",
  name: "User",
  workspace: { id: "00000000-0000-4000-8000-0000000000aa", name: "A", slug: "a", status: "active" },
  role: "employee",
  permissions: ["dashboard.read", "contacts.read"],
  isPlatformAdmin: false,
  grant: null,
  ...over,
});

describe("P2: AUTH_PROVIDER switch and Supabase configuration", () => {
  test("defaults to legacy; accepts legacy/supabase in any case; anything else is a misconfiguration", () => {
    assert.equal(authProvider({}), "legacy");
    assert.equal(authProvider({ AUTH_PROVIDER: " " }), "legacy");
    assert.equal(authProvider({ AUTH_PROVIDER: "Legacy" }), "legacy");
    assert.equal(authProvider({ AUTH_PROVIDER: "SUPABASE" }), "supabase");
    assert.equal(authProvider({ AUTH_PROVIDER: "supabse" }), null);
    assert.equal(authProvider({ AUTH_PROVIDER: "open" }), null);
  });

  test("Supabase auth config needs a valid URL and the anon (or publishable) key", () => {
    assert.equal(supabaseAuthConfig({}), null);
    assert.equal(supabaseAuthConfig({ SUPABASE_URL: "http://127.0.0.1:54321" }), null);
    assert.equal(supabaseAuthConfig({ SUPABASE_URL: "not a url", SUPABASE_ANON_KEY: "k" }), null);
    assert.equal(supabaseAuthConfig({ SUPABASE_URL: "ftp://host", SUPABASE_ANON_KEY: "k" }), null);
    assert.deepEqual(supabaseAuthConfig({ SUPABASE_URL: "http://127.0.0.1:54321/", SUPABASE_ANON_KEY: "k" }),
      { url: "http://127.0.0.1:54321", anonKey: "k" });
    assert.deepEqual(supabaseAuthConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "p" }),
      { url: "https://x.supabase.co", anonKey: "p" });
  });

  test("Supabase session cookies are httpOnly, lax, and secure in production", () => {
    assert.deepEqual(supabaseCookieOptions({}), { httpOnly: true, sameSite: "lax", path: "/", secure: false });
    assert.equal(supabaseCookieOptions({ NODE_ENV: "production" } as NodeJS.ProcessEnv).secure, true);
    assert.equal(supabaseCookieOptions({ VERCEL_ENV: "production" }).secure, true);
  });
});

describe("P2: request context evaluation (§5.1, §7.1)", () => {
  test("no session is unauthenticated", () => {
    assert.equal(evaluateContext(null), "unauthenticated");
    assert.equal(evaluateContext(null, { allowNoWorkspace: true }), "unauthenticated");
  });

  test("a user without a usable workspace gets no_active_workspace unless the route allows it", () => {
    assert.equal(evaluateContext(ctx({ workspace: null, role: null, permissions: [] })), "no_active_workspace");
    assert.equal(evaluateContext(ctx({ workspace: null, role: null }), { allowNoWorkspace: true }), null);
    assert.equal(evaluateContext(ctx({ workspace: { id: "w", name: "W", slug: "w", status: "archived" } })), "no_active_workspace");
    assert.equal(evaluateContext(ctx({ role: null, grant: null })), "no_active_workspace");
  });

  test("a suspended workspace refuses members and write grants but honours read grants", () => {
    const suspended = { id: "w", name: "W", slug: "w", status: "suspended" as const };
    assert.equal(evaluateContext(ctx({ workspace: suspended, role: null, permissions: [] })), "workspace_suspended");
    assert.equal(evaluateContext(ctx({ workspace: suspended, role: "owner" })), "workspace_suspended");
    assert.equal(evaluateContext(ctx({ workspace: suspended, role: null, isPlatformAdmin: true,
      grant: { id: "g", mode: "write", expiresAt: "2099-01-01T00:00:00Z" } })), "workspace_suspended");
    assert.equal(evaluateContext(ctx({ workspace: suspended, role: null, isPlatformAdmin: true,
      grant: { id: "g", mode: "read", expiresAt: "2099-01-01T00:00:00Z" } })), null);
  });

  test("permissions come only from the database context", () => {
    assert.equal(evaluateContext(ctx(), { permission: "contacts.read" }), null);
    assert.equal(evaluateContext(ctx(), { permission: "onboarding.read" }), "forbidden");
    assert.equal(evaluateContext(ctx({ role: "owner", permissions: ["onboarding.read"] }), { permission: "onboarding.read" }), null);
  });

  test("denials map to the §7.1 status codes with a human message and stable code", async () => {
    const expected = {
      unauthenticated: 401, no_active_workspace: 403, workspace_suspended: 423, forbidden: 403,
    } as const;
    for (const [code, status] of Object.entries(expected)) {
      const res = denialResponse(code as keyof typeof expected);
      assert.equal(res.status, status, code);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, code);
      assert.equal(typeof body.error, "string");
    }
  });

  test("workspace roles map to legacy roles for existing UI predicates (§7.2)", () => {
    assert.equal(legacyRoleOf("owner"), "OWNER");
    assert.equal(legacyRoleOf("admin"), "ADMIN");
    assert.equal(legacyRoleOf("employee"), "CLIENT");
    assert.equal(legacyRoleOf(null), null);
  });
});

describe("P2: AUTH_PROVIDER=supabase routing without a session (no network)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv();
    process.env.AUTH_PROVIDER = "supabase";
    process.env.SUPABASE_URL = DEAD_URL;
    process.env.SUPABASE_ANON_KEY = FAKE_ANON;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.AUTH_SECRET;
    delete process.env.VERCEL_ENV;
  });
  afterEach(() => restore());

  test("middleware: protected pages redirect (307) to /login?next=…, protected APIs answer 401 JSON", async () => {
    const page = await middleware(req("/contacts"));
    assert.equal(page.status, 307);
    const loc = new URL(page.headers.get("location")!);
    assert.equal(loc.pathname, "/login");
    assert.equal(loc.searchParams.get("next"), "/contacts");

    const root = await middleware(req("/"));
    assert.equal(new URL(root.headers.get("location")!).searchParams.get("next"), "/dashboard");

    for (const path of ["/api/dashboard/summary", "/api/workspaces", "/api/platform/workspace-logo", "/api/tenant/config"]) {
      const api = await middleware(req(path));
      assert.equal(api.status, 401, path);
      assert.deepEqual(await api.json(), { ok: false, error: "Unauthorized", code: "unauthenticated" });
    }
    const noAccess = await middleware(req("/no-access"));
    assert.equal(noAccess.status, 307, "session-only pages still need a session");
  });

  test("middleware: public paths pass through", async () => {
    for (const path of ["/login", "/privacy", "/terms", "/api/health", "/api/auth/login", "/api/auth/me", "/api/tenant/public"]) {
      const res = await middleware(req(path));
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("location"), null, path);
    }
  });

  test("ISO-F4: a valid legacy fna_session cookie is ignored in supabase mode", async () => {
    process.env.AUTH_SECRET = "legacy-secret-for-test-only-0123456789";
    process.env.AUTH_OWNER_EMAIL = "owner@example.invalid";
    process.env.AUTH_OWNER_PASSWORD = "owner-pass";
    process.env.AUTH_ALLOW_MEMORY_SESSIONS = "true";
    resetAuthSessionsForTests();
    const user = authenticateCredentials("owner@example.invalid", "owner-pass");
    assert.ok(user);
    const token = await createSessionToken(user!, process.env.AUTH_SECRET);
    const cookie = `${AUTH_COOKIE}=${token}`;

    assert.equal((await middleware(req("/dashboard", { cookie }))).status, 307);
    assert.equal((await middleware(req("/api/dashboard/summary", { cookie }))).status, 401);
    const config = await getTenantConfig(req("/api/tenant/config", { cookie }));
    assert.equal(config.status, 401);
    assert.equal((await config.json()).code, "unauthenticated");
    const me = await getMe(req("/api/auth/me", { cookie }));
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user, null);
  });

  test("a forged Supabase session cookie is refused (verification fails closed when Auth is unreachable)", async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: "00000000-0000-4000-8000-000000000009", role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600, aal: "aal2" })}.${Buffer.from("forged").toString("base64url")}`;
    const session = { access_token: jwt, refresh_token: "forged", token_type: "bearer", expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "00000000-0000-4000-8000-000000000009" } };
    const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    assert.equal((await middleware(req("/api/dashboard/summary", { cookie }))).status, 401);
    assert.equal((await middleware(req("/dashboard", { cookie }))).status, 307);
  });

  test("guards answer 401 with the stable code; role-gated APIs too", async () => {
    const ownerGate = async (r: NextRequest) => (await requireApiRole(r, "OWNER")).error!;
    for (const handler of [getTenantConfig, ownerGate, getWorkspaces]) {
      const res = await handler(req("/api/x"));
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "unauthenticated");
    }
    const active = await postActive(req("/api/workspaces/active", { method: "POST", body: { workspaceId: "x" } }));
    assert.equal(active.status, 401, "authentication is checked before input validation");
    const logo = await putLogo(req("/api/platform/workspace-logo", { method: "PUT", body: "x", contentType: "image/png" }));
    assert.equal(logo.status, 401);
  });

  test("/api/auth/me reports enforced auth and a null user when signed out", async () => {
    const res = await getMe(req("/api/auth/me"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.authEnforced, true);
    assert.equal(body.user, null);
    assert.deepEqual(body.permissions, []);
    assert.equal(interpretAuthMeProbe(res.status, body).authReady, true);
  });

  test("login validates input and reports an unreachable Auth server as 503, not as bad credentials", async () => {
    const empty = await postLogin(req("/api/auth/login", { method: "POST", body: { email: "", password: "" } }));
    assert.equal(empty.status, 400);
    const bad = await postLogin(req("/api/auth/login", { method: "POST", body: "{not json" }));
    assert.equal(bad.status, 400);
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const simple = await postLogin(req("/api/auth/login", { method: "POST", body: { email: "a@example.invalid", password: "x" }, contentType }));
      assert.deepEqual([simple.status, (await simple.json()).code], [400, "validation_failed"], `${contentType} refused before Auth is contacted`);
    }
    const down = await postLogin(req("/api/auth/login", { method: "POST", body: { email: "a@example.invalid", password: "x" } }));
    assert.equal(down.status, 503);
    assert.equal((await down.json()).code, "unavailable");
  });

  test("login maps Supabase Auth answers: 429 → rate_limited, 400 → generic 401, 500 → 503", async () => {
    let answer = { status: 429, body: { code: "over_request_rate_limit", msg: "rate limited" } };
    const server = createServer((_req, res) => {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = () => postLogin(req("/api/auth/login", { method: "POST", body: { email: "a@example.invalid", password: "x" } }));
    try {
      const limited = await login();
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" });
      answer = { status: 400, body: { code: "invalid_credentials", msg: "Invalid login credentials" } };
      const wrong = await login();
      assert.equal(wrong.status, 401);
      assert.deepEqual(await wrong.json(), { ok: false, error: "Invalid credentials", code: "unauthenticated" });
      answer = { status: 500, body: { code: "unexpected_failure", msg: "boom" } };
      const broken = await login();
      assert.equal(broken.status, 503);
      assert.equal((await broken.json()).code, "unavailable");
    } finally {
      server.close();
    }
  });

  test("logout always succeeds and clears Supabase auth cookies", async () => {
    const res = await postLogout(req("/api/auth/logout", { method: "POST", cookie: "sb-127-auth-token=base64-e30; other=1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const cleared = res.cookies.get("sb-127-auth-token");
    assert.ok(cleared, "auth cookie must be cleared");
    assert.equal(cleared!.value, "");
    assert.equal(res.cookies.get("other"), undefined);
  });

  test("missing Supabase config fails closed everywhere", async () => {
    delete process.env.SUPABASE_URL;
    const api = await middleware(req("/api/dashboard/summary"));
    assert.equal(api.status, 503);
    assert.equal((await api.json()).code, "auth_misconfigured");
    const page = await middleware(req("/dashboard"));
    assert.equal(new URL(page.headers.get("location")!).searchParams.get("error"), "auth_misconfigured");
    assert.equal((await getTenantConfig(req("/api/tenant/config"))).status, 503);
    const login = await postLogin(req("/api/auth/login", { method: "POST", body: { email: "a@example.invalid", password: "x" } }));
    assert.equal(login.status, 503);
    const me = await getMe(req("/api/auth/me"));
    assert.equal(me.status, 503);
    assert.equal(interpretAuthMeProbe(me.status, await me.json()).misconfigured, true);
  });

  test("an unsupported AUTH_PROVIDER value fails closed instead of opening routes", async () => {
    process.env.AUTH_PROVIDER = "none";
    assert.equal((await middleware(req("/api/dashboard/summary"))).status, 503);
    assert.equal(new URL((await middleware(req("/dashboard"))).headers.get("location")!).searchParams.get("error"), "auth_misconfigured");
    assert.equal((await getTenantConfig(req("/api/tenant/config"))).status, 503);
    assert.equal((await postLogin(req("/api/auth/login", { method: "POST", body: { email: "a@example.invalid", password: "x" } }))).status, 503);
    assert.equal((await getMe(req("/api/auth/me"))).status, 503);
  });

  test("Supabase-only endpoints are absent in legacy mode", async () => {
    process.env.AUTH_PROVIDER = "legacy";
    assert.equal((await getWorkspaces(req("/api/workspaces"))).status, 404);
    assert.equal((await postActive(req("/api/workspaces/active", { method: "POST", body: {} }))).status, 404);
    assert.equal((await putLogo(req("/api/platform/workspace-logo", { method: "PUT", body: "x", contentType: "image/png" }))).status, 404);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

describe("P2: static guards", () => {
  test("SR-1: only the allowlisted admin module (and the legacy snapshot/session code until T6) reads the service-role key", () => {
    const LEGACY_UNTIL_T6 = new Set([
      "src/lib/legacy/rest-client.ts",
      "src/lib/legacy/rest-auth.ts",
      "src/lib/auth/session-store.ts",
      "src/lib/auth/session-edge.ts",
    ]);
    const readers = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))]
      .filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"))
      .map(rel);
    for (const f of readers) {
      assert.ok(f === "src/lib/supabase/admin.ts" || LEGACY_UNTIL_T6.has(f), `${f} reads SUPABASE_SERVICE_ROLE_KEY`);
    }
    const importers = walk(join(ROOT, "src"))
      .filter((f) => /from\s+["'](@\/lib\/supabase\/admin|[./]+supabase\/admin)["']/.test(readFileSync(f, "utf8")))
      .map(rel);
    assert.deepEqual(importers.sort(), [
      "src/app/api/invitations/[token]/accept/route.ts", // A1 (P4)
      "src/app/api/platform/workspace-logo/route.ts", // A5 (P2)
    ]);
    const acceptRoute = readFileSync(join(ROOT, "src/app/api/invitations/[token]/accept/route.ts"), "utf8");
    assert.match(acceptRoute, /import \{ createUserFromInvitation \} from "@\/lib\/supabase\/admin";/, "A1 caller imports only createUserFromInvitation");
    for (const f of ["src/middleware.ts", "src/lib/auth/provider.ts", "src/lib/supabase/server.ts", "src/lib/authz/context.ts"]) {
      assert.equal(readFileSync(join(ROOT, f), "utf8").includes("SERVICE_ROLE"), false, `${f} must not touch the service role`);
    }
    assert.match(readFileSync(join(ROOT, "src/lib/supabase/admin.ts"), "utf8"), /^import "server-only";/);
  });

  test("ISO-F1: no route handler reads a workspace id from the client, except the spec's switch endpoint", () => {
    const routes = walk(join(ROOT, "src/app/api")).filter((f) => f.endsWith("route.ts"));
    for (const f of routes) {
      const src = readFileSync(f, "utf8");
      const name = rel(f);
      if (name === "src/app/api/workspaces/active/route.ts") {
        assert.match(src, /rpc\("switch_workspace"/);
        continue;
      }
      assert.doesNotMatch(src, /(body|searchParams|headers|cookies|params)\b[^;\n]*workspace[_-]?id/i, name);
      assert.doesNotMatch(src, /x-workspace-id/i, name);
    }
  });

  test("new auth modules keep no cross-request state (no globalThis, no module-level clients)", () => {
    for (const f of ["src/middleware.ts", "src/lib/auth/provider.ts", "src/lib/supabase/server.ts",
      "src/lib/supabase/admin.ts", "src/lib/authz/context.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      assert.equal(src.includes("globalThis"), false, f);
      assert.doesNotMatch(src, /^(export )?const \w+ = create(Server)?Client\(/m, f);
    }
  });

  test("the AAL1 platform override is never enabled by repository config or code", () => {
    const files = [
      ...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts")),
      join(ROOT, "supabase", "config.toml"),
      ...readdirSync(join(ROOT, "supabase", "migrations")).map((f) => join(ROOT, "supabase", "migrations", f)),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /platform_allow_aal1['"]?\s*(=|to|,)\s*['"]?on/i, rel(f));
      assert.doesNotMatch(src, /set_config\(\s*'app\.platform_allow_aal1'/i, rel(f));
    }
  });

  test("protected pages keep their existing gates; Setup and Resources use the §4.3 permissions", () => {
    assert.match(readFileSync(join(ROOT, "src/app/(protected)/onboarding/page.tsx"), "utf8"), /requirePageRole\("OWNER", "onboarding\.read"\)/);
    assert.match(readFileSync(join(ROOT, "src/app/(protected)/library/page.tsx"), "utf8"), /requirePageRole\("ADMIN", "library\.read"\)/);
    assert.match(readFileSync(join(ROOT, "src/app/(protected)/layout.tsx"), "utf8"), /requirePageSession\(\)/);
    const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.tsx"), "utf8");
    assert.match(sidebar, /href: "\/onboarding", label: "Setup", icon: "automations", minRole: "OWNER", permission: "onboarding\.read"/);
    assert.match(sidebar, /href: "\/library", label: "Resources", icon: "resources", minRole: "ADMIN", permission: "library\.read"/);
  });

  test("middleware decides page access before rendering: workspace denials and §4.3 page permissions", () => {
    assert.equal(pagePermission("/onboarding"), "onboarding.read");
    assert.equal(pagePermission("/onboarding/step"), "onboarding.read");
    assert.equal(pagePermission("/library"), "library.read");
    assert.equal(pagePermission("/librarian"), undefined);
    assert.equal(pagePermission("/dashboard"), undefined);
    assert.deepEqual(PAGE_DENIAL_REDIRECT, {
      unauthenticated: "/login", no_active_workspace: "/no-access",
      workspace_suspended: "/workspace-suspended", forbidden: "/dashboard?denied=1",
    });
    const mw = readFileSync(join(ROOT, "src/middleware.ts"), "utf8");
    assert.match(mw, /supabase\.rpc\("request_context"\)/);
    assert.match(mw, /evaluateContext\(ctx, \{ permission: pagePermission\(pathname\) \}\)/);
  });
});

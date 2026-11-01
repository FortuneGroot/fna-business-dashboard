import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { NextRequest } from "next/server";
import {
  AUTH_COOKIE,
  authenticateCredentials,
  canAccessLibrary,
  canAccessOwnerApis,
  canAccessOwnerSettings,
  canAccessSyncHealth,
  createSessionToken,
  requireApiRole,
  resetAuthSessionsForTests,
  roleSatisfies,
  sessionCookieOptions,
} from "../src/lib/auth";
import { GET as getTenantPublic } from "../src/app/api/tenant/public/route";
import { GET as getTenantConfig } from "../src/app/api/tenant/config/route";
import { GET as getSummary } from "../src/app/api/dashboard/summary/route";

async function roleGate(r: NextRequest, minimum: "OWNER" | "ADMIN"): Promise<number> {
  const { error } = await requireApiRole(r, minimum);
  return error ? error.status : 200;
}

const SECRET = "test-auth-secret-roles-do-not-use-in-prod";

async function cookieFor(
  email: string,
  password: string
): Promise<string> {
  const user = authenticateCredentials(email, password);
  assert.ok(user, `expected user for ${email}`);
  const token = await createSessionToken(user!, SECRET);
  const opts = sessionCookieOptions();
  return `${AUTH_COOKIE}=${token}; Path=${opts.path || "/"}`;
}

function req(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
}

describe("role authorization helpers", () => {
  it("roleSatisfies ranks OWNER > ADMIN > CLIENT", () => {
    assert.equal(roleSatisfies("OWNER", "OWNER"), true);
    assert.equal(roleSatisfies("OWNER", "ADMIN"), true);
    assert.equal(roleSatisfies("ADMIN", "ADMIN"), true);
    assert.equal(roleSatisfies("ADMIN", "OWNER"), false);
    assert.equal(roleSatisfies("CLIENT", "ADMIN"), false);
    assert.equal(roleSatisfies("CLIENT", "CLIENT"), true);
  });

  it("feature gates match product matrix", () => {
    assert.equal(canAccessLibrary("CLIENT"), false);
    assert.equal(canAccessLibrary("ADMIN"), true);
    assert.equal(canAccessLibrary("OWNER"), true);
    assert.equal(canAccessOwnerSettings("CLIENT"), false);
    assert.equal(canAccessOwnerSettings("ADMIN"), false);
    assert.equal(canAccessOwnerSettings("OWNER"), true);
    assert.equal(canAccessSyncHealth("CLIENT"), false);
    assert.equal(canAccessSyncHealth("ADMIN"), true);
    assert.equal(canAccessOwnerApis("ADMIN"), false);
    assert.equal(canAccessOwnerApis("OWNER"), true);
  });
});

describe("tenant exposure split + role API gates", () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetAuthSessionsForTests();
    for (const k of [
      "AUTH_SECRET",
      "AUTH_OWNER_EMAIL",
      "AUTH_OWNER_PASSWORD",
      "AUTH_ADMIN_EMAIL",
      "AUTH_ADMIN_PASSWORD",
      "AUTH_CLIENT_EMAIL",
      "AUTH_CLIENT_PASSWORD",
      "VERCEL_ENV",
      "AUTH_FAIL_CLOSED",
      "AUTH_ALLOW_MEMORY_SESSIONS",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      prev[k] = process.env[k];
    }
    process.env.AUTH_SECRET = SECRET;
    process.env.AUTH_OWNER_EMAIL = "owner@example.invalid";
    process.env.AUTH_OWNER_PASSWORD = "owner-pass";
    process.env.AUTH_ADMIN_EMAIL = "admin@example.invalid";
    process.env.AUTH_ADMIN_PASSWORD = "admin-pass";
    process.env.AUTH_CLIENT_EMAIL = "client@example.invalid";
    process.env.AUTH_CLIENT_PASSWORD = "client-pass";
    process.env.AUTH_ALLOW_MEMORY_SESSIONS = "true";
    delete process.env.VERCEL_ENV;
    delete process.env.AUTH_FAIL_CLOSED;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("anonymous /api/tenant/public returns branding only (no contact/config)", async () => {
    const res = await getTenantPublic();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.platform?.brandName);
    assert.ok(body.client?.businessName);
    assert.equal(body.client?.supportEmail, undefined);
    assert.equal(body.client?.phone, undefined);
    assert.equal(body.client?.website, undefined);
    assert.equal(body.client?.bookingUrl, undefined);
    assert.equal(body.client?.pipelineName, undefined);
    assert.equal(body.client?.locationConfigured, undefined);
    assert.equal(body.owner, undefined);
  });

  it("anonymous restricted APIs and role gates return 401 JSON (not HTML login)", async () => {
    for (const [label, handler] of [
      ["tenant/config", getTenantConfig],
      ["dashboard/summary", getSummary],
    ] as const) {
      const res = await handler(req(`/api/${label}`));
      assert.equal(res.status, 401, label);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "Unauthorized");
    }
    assert.equal(await roleGate(req("/api/x"), "ADMIN"), 401);
  });

  it("CLIENT is refused by ADMIN and OWNER gates and gets no owner block on tenant config", async () => {
    const cookie = await cookieFor("client@example.invalid", "client-pass");

    const configRes = await getTenantConfig(req("/api/tenant/config", cookie));
    assert.equal(configRes.status, 200);
    const configBody = await configRes.json();
    assert.ok(configBody.client?.supportEmail !== undefined || configBody.client?.phone !== undefined || configBody.ok);
    assert.equal(configBody.owner, undefined);

    assert.equal(await roleGate(req("/api/x", cookie), "ADMIN"), 403);
    assert.equal(await roleGate(req("/api/x", cookie), "OWNER"), 403);
    const { error } = await requireApiRole(req("/api/x", cookie), "OWNER");
    assert.equal((await error!.json()).error, "Forbidden");
  });

  it("ADMIN passes the ADMIN gate but not the OWNER gate, and gets no owner block", async () => {
    const cookie = await cookieFor("admin@example.invalid", "admin-pass");

    assert.equal(await roleGate(req("/api/x", cookie), "ADMIN"), 200);
    assert.equal(await roleGate(req("/api/x", cookie), "OWNER"), 403);

    const config = await getTenantConfig(req("/api/tenant/config", cookie));
    assert.equal(config.status, 200);
    assert.equal((await config.json()).owner, undefined);
  });

  it("OWNER passes every gate and receives the owner tenant configuration", async () => {
    const cookie = await cookieFor("owner@example.invalid", "owner-pass");

    assert.equal(await roleGate(req("/api/x", cookie), "OWNER"), 200);

    const config = await getTenantConfig(req("/api/tenant/config", cookie));
    assert.equal(config.status, 200);
    const body = await config.json();
    assert.deepEqual(body.owner, { pipelineName: "Fortune & Automations Sales Pipeline", stagesCount: 12 });
  });

  it("anonymous tenant/public never includes location or pipeline IDs", async () => {
    const res = await getTenantPublic();
    const text = JSON.stringify(await res.json());
    assert.equal(/locationId|pipelineId|NQwD3zdWCuBSVpOuzybj|pit-/i.test(text), false);
  });
});

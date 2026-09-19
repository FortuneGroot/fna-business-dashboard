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
  resetAuthSessionsForTests,
  roleSatisfies,
  sessionCookieOptions,
} from "../src/lib/auth";
import { GET as getTenantPublic } from "../src/app/api/tenant/public/route";
import { GET as getTenantConfig } from "../src/app/api/tenant/config/route";
import { GET as getEvents } from "../src/app/api/events/route";
import { GET as getSyncHealth } from "../src/app/api/sync/health/route";
import { GET as getReadiness } from "../src/app/api/onboarding/readiness/route";

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

  it("anonymous restricted APIs return 401 JSON (not HTML login)", async () => {
    for (const [label, handler] of [
      ["tenant/config", getTenantConfig],
      ["events", getEvents],
      ["sync/health", getSyncHealth],
      ["onboarding/readiness", getReadiness],
    ] as const) {
      const res = await handler(req(`/api/${label}`));
      assert.equal(res.status, 401, label);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "Unauthorized");
    }
  });

  it("CLIENT receives 403 on owner/admin APIs and no owner block on tenant config", async () => {
    const cookie = await cookieFor("client@example.invalid", "client-pass");

    const configRes = await getTenantConfig(req("/api/tenant/config", cookie));
    assert.equal(configRes.status, 200);
    const configBody = await configRes.json();
    assert.ok(configBody.client?.supportEmail !== undefined || configBody.client?.phone !== undefined || configBody.ok);
    assert.equal(configBody.owner, undefined);

    const events = await getEvents(req("/api/events", cookie));
    assert.equal(events.status, 403);
    assert.equal((await events.json()).error, "Forbidden");

    const readiness = await getReadiness(req("/api/onboarding/readiness", cookie));
    assert.equal(readiness.status, 403);

    const sync = await getSyncHealth(req("/api/sync/health", cookie));
    assert.equal(sync.status, 403);
  });

  it("ADMIN can read sync health but not owner-only APIs", async () => {
    const cookie = await cookieFor("admin@example.invalid", "admin-pass");

    const sync = await getSyncHealth(req("/api/sync/health", cookie));
    assert.equal(sync.status, 200);
    const syncBody = await sync.json();
    assert.equal(syncBody.ok, true);

    const events = await getEvents(req("/api/events", cookie));
    assert.equal(events.status, 403);

    const readiness = await getReadiness(req("/api/onboarding/readiness", cookie));
    assert.equal(readiness.status, 403);

    const config = await getTenantConfig(req("/api/tenant/config", cookie));
    assert.equal(config.status, 200);
    assert.equal((await config.json()).owner, undefined);
  });

  it("OWNER can access owner APIs and owner tenant configuration", async () => {
    const cookie = await cookieFor("owner@example.invalid", "owner-pass");

    const events = await getEvents(req("/api/events", cookie));
    assert.equal(events.status, 200);

    const readiness = await getReadiness(req("/api/onboarding/readiness", cookie));
    assert.equal(readiness.status, 200);

    const sync = await getSyncHealth(req("/api/sync/health", cookie));
    assert.equal(sync.status, 200);

    const config = await getTenantConfig(req("/api/tenant/config", cookie));
    assert.equal(config.status, 200);
    const body = await config.json();
    assert.ok(body.owner);
    assert.equal(typeof body.owner.locationConfigured, "boolean");
  });

  it("anonymous tenant/public never includes location or pipeline IDs", async () => {
    const res = await getTenantPublic();
    const text = JSON.stringify(await res.json());
    assert.equal(/locationId|pipelineId|NQwD3zdWCuBSVpOuzybj|pit-/i.test(text), false);
  });
});

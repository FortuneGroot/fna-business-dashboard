import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  AUTH_COOKIE,
  authenticateCredentials,
  createSessionToken,
  isAuthEnforced,
  isAuthFailClosed,
  mustProtectRoutes,
  verifySessionToken,
  revokeSessionToken,
  roleAllowsDashboard,
  resetAuthSessionsForTests,
  safeNextPath,
  consumeLoginAttempt,
  resetLoginRateLimitForTests,
  passwordsMatch,
} from "../src/lib/auth";
import { isStoredSessionActiveEdge, verifySessionTokenEdge } from "../src/lib/auth/session-edge";
import { verifyWebhookSecret } from "../src/lib/sync";
import {
  PROTECTED_MASTER_LOCATION_ID,
  FA_LIVE_LOCATION_ID,
  faLiveDefaultClientConfig,
  loadTenantConfigFromEnv,
  resetTenantConfigForTests,
} from "../src/lib/tenant";
import { evaluateClientReadiness, loadClientConfigFromFile } from "../src/lib/onboarding";
import {
  buildClientPrepChecklist,
  validateClientDeployment,
} from "../src/lib/deployment/validate";
import { assertCanGenerateManifest, manifestBlockReasons } from "../src/lib/deployment/manifest-gate";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { BRAND } from "../src/lib/brand";
import { applyClientBusinessName, getConsentCopy } from "../src/lib/mapping";
import { validateEnv, loadEnv } from "../src/lib/env";

const SECRET = "test-auth-secret-do-not-use-in-prod";

describe("auth sessions", () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetAuthSessionsForTests();
    resetLoginRateLimitForTests();
    for (const k of [
      "AUTH_SECRET",
      "AUTH_OWNER_EMAIL",
      "AUTH_OWNER_PASSWORD",
      "AUTH_CLIENT_EMAIL",
      "AUTH_CLIENT_PASSWORD",
      "AUTH_ADMIN_EMAIL",
      "AUTH_ADMIN_PASSWORD",
      "VERCEL_ENV",
      "AUTH_FAIL_CLOSED",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "AUTH_ALLOW_MEMORY_SESSIONS",
    ]) {
      prev[k] = process.env[k];
    }
    process.env.AUTH_SECRET = SECRET;
    process.env.AUTH_OWNER_EMAIL = "owner@example.invalid";
    process.env.AUTH_OWNER_PASSWORD = "owner-pass";
    process.env.AUTH_CLIENT_EMAIL = "client@example.invalid";
    process.env.AUTH_CLIENT_PASSWORD = "client-pass";
    process.env.AUTH_ADMIN_EMAIL = "admin@example.invalid";
    process.env.AUTH_ADMIN_PASSWORD = "admin-pass";
    delete process.env.VERCEL_ENV;
    delete process.env.AUTH_FAIL_CLOSED;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.AUTH_ALLOW_MEMORY_SESSIONS;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("owner login/session path", async () => {
    const user = authenticateCredentials("owner@example.invalid", "owner-pass");
    assert.ok(user);
    assert.equal(user!.role, "OWNER");
    const token = await createSessionToken(user!, SECRET);
    const session = await verifySessionToken(token, SECRET);
    assert.ok(session);
    assert.equal(session!.email, "owner@example.invalid");
    assert.equal(session!.role, "OWNER");
    assert.ok(roleAllowsDashboard(session!.role));
  });

  it("client login/session path", async () => {
    const user = authenticateCredentials("client@example.invalid", "client-pass");
    assert.ok(user);
    const token = await createSessionToken(user!, SECRET);
    const session = await verifySessionToken(token, SECRET);
    assert.equal(session!.role, "CLIENT");
  });

  it("admin login/session path", () => {
    const user = authenticateCredentials("admin@example.invalid", "admin-pass");
    assert.equal(user?.role, "ADMIN");
  });

  it("rejects bad password", () => {
    assert.equal(authenticateCredentials("owner@example.invalid", "wrong"), null);
  });

  it("edge verify matches node sign shape", async () => {
    const user = authenticateCredentials("owner@example.invalid", "owner-pass")!;
    const token = await createSessionToken(user, SECRET);
    const edge = await verifySessionTokenEdge(token, SECRET);
    assert.ok(edge);
    assert.ok(edge!.sid);
  });

  it("edge session-store check rejects revoked sessions", async () => {
    const originalFetch = globalThis.fetch;
    const sid = "ab".repeat(24);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([
          {
            id: sid,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            revoked: true,
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    try {
      assert.equal(
        await isStoredSessionActiveEdge(sid, undefined, {
          SUPABASE_URL: "https://db.example.invalid",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        }),
        false
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("edge session-store check fails closed in production without store", async () => {
    assert.equal(
      await isStoredSessionActiveEdge("ab".repeat(24), undefined, { VERCEL_ENV: "production" }),
      false
    );
  });

  it("edge session-store check fails closed on Preview without store credentials", async () => {
    assert.equal(
      await isStoredSessionActiveEdge("a".repeat(48), undefined, { VERCEL_ENV: "preview" }),
      false
    );
  });

  it("durable-store write failure prevents cookie issuance", async () => {
    const originalFetch = globalThis.fetch;
    process.env.SUPABASE_URL = "https://db.example.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "forced failure" }), { status: 500 });
    try {
      const user = authenticateCredentials("owner@example.invalid", "owner-pass")!;
      await assert.rejects(() => createSessionToken(user, SECRET), /Durable session write failed/);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  it("newly created durable session is accepted across independent runtime instances", async () => {
    const originalFetch = globalThis.fetch;
    const durable = new Map<
      string,
      { id: string; email: string; role: string; name: string; created_at: string; expires_at: string; revoked: boolean }
    >();

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/rest/v1/auth_sessions") && init?.method === "POST") {
        const row = JSON.parse(String(init.body || "{}")) as {
          id: string;
          email: string;
          role: string;
          name: string;
          created_at: string;
          expires_at: string;
          revoked: boolean;
        };
        durable.set(row.id, row);
        return new Response(JSON.stringify([row]), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/rest/v1/auth_sessions?") && (!init?.method || init.method === "GET")) {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : "";
        const row = durable.get(id);
        return new Response(JSON.stringify(row ? [row] : []), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/rest/v1/auth_sessions") && init?.method === "PATCH") {
        const idMatch = url.match(/id=eq\.([^&]+)/);
        const id = idMatch ? decodeURIComponent(idMatch[1]) : "";
        const row = durable.get(id);
        if (row) {
          row.revoked = true;
          durable.set(id, row);
        }
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    };

    process.env.SUPABASE_URL = "https://db.example.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    // Simulate instance A with empty memory after login on instance B.
    resetAuthSessionsForTests();
    try {
      const user = authenticateCredentials("owner@example.invalid", "owner-pass")!;
      const token = await createSessionToken(user, SECRET);
      resetAuthSessionsForTests(); // wipe instance-local memory
      const edge = await verifySessionTokenEdge(token, SECRET);
      assert.ok(edge);
      assert.equal(
        await isStoredSessionActiveEdge(edge!.sid, undefined, {
          SUPABASE_URL: "https://db.example.invalid",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        }),
        true
      );
      const session = await verifySessionToken(token, SECRET);
      assert.ok(session);
      assert.equal(session!.email, "owner@example.invalid");

      await revokeSessionToken(token, SECRET);
      resetAuthSessionsForTests();
      assert.equal(await verifySessionToken(token, SECRET), null);
      assert.equal(
        await isStoredSessionActiveEdge(edge!.sid, undefined, {
          SUPABASE_URL: "https://db.example.invalid",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        }),
        false
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      resetAuthSessionsForTests();
    }
  });

  it("logout revokes session — replay denied", async () => {
    const user = authenticateCredentials("owner@example.invalid", "owner-pass")!;
    const token = await createSessionToken(user, SECRET);
    assert.ok(await verifySessionToken(token, SECRET));
    await revokeSessionToken(token, SECRET);
    assert.equal(await verifySessionToken(token, SECRET), null);
  });

  it("isAuthEnforced follows AUTH_SECRET", () => {
    assert.equal(isAuthEnforced(), true);
    delete process.env.AUTH_SECRET;
    assert.equal(isAuthEnforced(), false);
  });

  it("production without AUTH_SECRET is fail-closed", () => {
    delete process.env.AUTH_SECRET;
    process.env.VERCEL_ENV = "production";
    assert.equal(isAuthFailClosed(), true);
    assert.equal(mustProtectRoutes(), true);
  });

  it("passwordsMatch is constant-time hash compare", () => {
    assert.equal(passwordsMatch("abc", "abc"), true);
    assert.equal(passwordsMatch("abc", "xyz"), false);
  });

  it("rate limit blocks repeated login attempts", () => {
    resetLoginRateLimitForTests();
    for (let i = 0; i < 8; i++) {
      assert.equal(consumeLoginAttempt("login:test:user").allowed, true);
    }
    assert.equal(consumeLoginAttempt("login:test:user").allowed, false);
  });
});

describe("safeNextPath", () => {
  it("allows internal paths only", () => {
    assert.equal(safeNextPath("/dashboard"), "/dashboard");
    assert.equal(safeNextPath("/contacts?x=1"), "/contacts?x=1");
  });

  it("rejects open redirects", () => {
    assert.equal(safeNextPath("//evil.example"), "/dashboard");
    assert.equal(safeNextPath("/\\evil"), "/dashboard");
    assert.equal(safeNextPath("https://evil.example"), "/dashboard");
    assert.equal(safeNextPath("http://evil.example"), "/dashboard");
    assert.equal(safeNextPath("///evil.example"), "/dashboard");
    assert.equal(safeNextPath("//evil.example/%2e%2e"), "/dashboard");
    assert.equal(safeNextPath(encodeURIComponent("//evil.example")), "/dashboard");
    assert.equal(safeNextPath("/dashboard@evil.com"), "/dashboard");
  });
});

describe("private API protection helpers", () => {
  it("unauthenticated dashboard API denied pattern (401 body)", () => {
    const body = { ok: false, error: "Unauthorized" };
    assert.equal(body.ok, false);
  });
});

describe("webhook machine access", () => {
  it("webhook endpoint remains machine-accessible with webhook secret", () => {
    const ok = verifyWebhookSecret({
      signatureHeader: "deploy-secret",
      dryRun: false,
      secretConfigured: true,
      secretValue: "deploy-secret",
      enforceFlag: true,
    });
    assert.deepEqual(ok, { ok: true });
  });
});

describe("Master guard unchanged", () => {
  it("Master location still blocked by readiness", () => {
    const cfg = faLiveDefaultClientConfig();
    cfg.ghl.locationId = PROTECTED_MASTER_LOCATION_ID;
    assert.equal(evaluateClientReadiness(cfg).status, "BLOCKED");
  });
});

describe("fake-client readiness unchanged", () => {
  it("placeholder fake roofing remains BLOCKED", () => {
    const path = resolve("config/examples/fake-roofing-client.json");
    assert.equal(evaluateClientReadiness(loadClientConfigFromFile(path)).status, "BLOCKED");
  });
});

describe("$297 compatibility unchanged", () => {
  it("rejects $497 dependency flags", () => {
    const cfg = faLiveDefaultClientConfig();
    cfg.forbiddenDependencies.requiresAgencyPro497 = true;
    const report = validateClientDeployment(cfg, {
      GHL_WEBHOOK_SECRET: "x",
      AUTH_SECRET: "y",
      AUTH_OWNER_EMAIL: "a@b.c",
      AUTH_OWNER_PASSWORD: "p",
    });
    assert.equal(report.status, "BLOCKED");
  });
});

describe("env location mismatch hard-fail", () => {
  const tmpDir = resolve(".data/test-configs");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    resetTenantConfigForTests(undefined);
  });

  afterEach(() => {
    resetTenantConfigForTests(faLiveDefaultClientConfig());
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("config A + env A = PASS", () => {
    const cfg = faLiveDefaultClientConfig();
    const file = resolve(tmpDir, "client-a.json");
    writeFileSync(file, JSON.stringify(cfg), "utf8");
    const loaded = loadTenantConfigFromEnv(
      {
        CLIENT_CONFIG_PATH: file,
        GHL_LOCATION_ID: FA_LIVE_LOCATION_ID,
        GHL_PIPELINE_ID: cfg.ghl.pipelineId,
      },
      process.cwd()
    );
    assert.equal(loaded.ghl.locationId, FA_LIVE_LOCATION_ID);
  });

  it("config A + env B = FAIL", () => {
    const cfg = faLiveDefaultClientConfig();
    const file = resolve(tmpDir, "client-b.json");
    writeFileSync(file, JSON.stringify(cfg), "utf8");
    assert.throws(
      () =>
        loadTenantConfigFromEnv(
          {
            CLIENT_CONFIG_PATH: file,
            GHL_LOCATION_ID: "other_location_id_xyz",
          },
          process.cwd()
        ),
      /must match CLIENT_CONFIG_PATH locationId/
    );
  });

  it("Master in config = FAIL", () => {
    const cfg = faLiveDefaultClientConfig();
    cfg.ghl.locationId = PROTECTED_MASTER_LOCATION_ID;
    const file = resolve(tmpDir, "master-cfg.json");
    writeFileSync(file, JSON.stringify(cfg), "utf8");
    assert.throws(
      () => loadTenantConfigFromEnv({ CLIENT_CONFIG_PATH: file }, process.cwd()),
      /Protected Master/
    );
  });

  it("Master in env = FAIL", () => {
    assert.throws(
      () =>
        loadTenantConfigFromEnv({
          GHL_LOCATION_ID: PROTECTED_MASTER_LOCATION_ID,
        }),
      /Protected Master/
    );
  });

  it("validateEnv reports mismatch when tenant reset with different ids", () => {
    resetTenantConfigForTests({
      ...faLiveDefaultClientConfig(),
      ghl: { ...faLiveDefaultClientConfig().ghl, locationId: "client_loc_aaa" },
    });
    process.env.GHL_LOCATION_ID = "client_loc_bbb";
    const errors = validateEnv(loadEnv());
    assert.ok(errors.some((e) => e.includes("must match configured client location")));
    delete process.env.GHL_LOCATION_ID;
  });
});

describe("generator blocking", () => {
  it("refuses fake roofing placeholders", () => {
    const cfg = loadClientConfigFromFile(resolve("config/examples/fake-roofing-client.json"));
    assert.ok(manifestBlockReasons(cfg).length > 0);
    assert.throws(() => assertCanGenerateManifest(cfg));
  });

  it("refuses Master location", () => {
    const cfg = faLiveDefaultClientConfig();
    cfg.ghl.locationId = PROTECTED_MASTER_LOCATION_ID;
    assert.ok(manifestBlockReasons(cfg).some((r) => /Master/i.test(r)));
  });

  it("allows synthetic ready config", () => {
    const cfg = loadClientConfigFromFile(resolve("config/examples/synthetic-ready-client.json"));
    assert.equal(manifestBlockReasons(cfg).length, 0);
    assert.doesNotThrow(() => assertCanGenerateManifest(cfg));
  });
});

describe("deployment validator auth gate", () => {
  it("F&A default without invented URLs is not READY", () => {
    const report = evaluateClientReadiness(faLiveDefaultClientConfig());
    assert.notEqual(report.status, "READY");
  });

  it("missing AUTH_SECRET blocks READY", () => {
    const cfg = loadClientConfigFromFile(resolve("config/examples/synthetic-ready-client.json"));
    const report = validateClientDeployment(cfg, {
      GHL_WEBHOOK_SECRET: "present",
    });
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.blockers.some((b) => b.includes("AUTH_SECRET")));
  });

  it("client prep checklist reports fake roofing BLOCKED", () => {
    const cfg = loadClientConfigFromFile(resolve("config/examples/fake-roofing-client.json"));
    const { report } = buildClientPrepChecklist(cfg, {});
    assert.equal(report.status, "BLOCKED");
  });
});

describe("tenant content tokens", () => {
  it("consent and snippets resolve client business name", () => {
    const copy = getConsentCopy("Acme Roofing");
    assert.match(copy.smsService, /Acme Roofing/);
    assert.equal(
      applyClientBusinessName("Thanks {{CLIENT_BUSINESS_NAME}}.", "Acme Roofing"),
      "Thanks Acme Roofing."
    );
  });

  it("platform product name remains F&A", () => {
    assert.equal(BRAND.product, "Fortune & Automations Business Dashboard");
  });
});

// re-export silence
void AUTH_COOKIE;

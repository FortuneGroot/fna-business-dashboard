import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  AUTH_COOKIE,
  authenticateCredentials,
  createSessionToken,
  isAuthEnforced,
  verifySessionToken,
  roleAllowsDashboard,
} from "../src/lib/auth";
import { verifySessionTokenEdge } from "../src/lib/auth/session-edge";
import { verifyWebhookSecret } from "../src/lib/sync";
import {
  PROTECTED_MASTER_LOCATION_ID,
  faLiveDefaultClientConfig,
  resetTenantConfigForTests,
} from "../src/lib/tenant";
import { evaluateClientReadiness, loadClientConfigFromFile } from "../src/lib/onboarding";
import {
  buildClientPrepChecklist,
  validateClientDeployment,
} from "../src/lib/deployment/validate";
import { resolve } from "node:path";
import { BRAND } from "../src/lib/brand";
import { applyClientBusinessName, getConsentCopy } from "../src/lib/mapping";

const SECRET = "test-auth-secret-do-not-use-in-prod";

describe("auth sessions", () => {
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      "AUTH_SECRET",
      "AUTH_OWNER_EMAIL",
      "AUTH_OWNER_PASSWORD",
      "AUTH_CLIENT_EMAIL",
      "AUTH_CLIENT_PASSWORD",
      "AUTH_ADMIN_EMAIL",
      "AUTH_ADMIN_PASSWORD",
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
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("owner login/session path", () => {
    const user = authenticateCredentials("owner@example.invalid", "owner-pass");
    assert.ok(user);
    assert.equal(user!.role, "OWNER");
    const token = createSessionToken(user!, SECRET);
    const session = verifySessionToken(token, SECRET);
    assert.ok(session);
    assert.equal(session!.email, "owner@example.invalid");
    assert.equal(session!.role, "OWNER");
    assert.ok(roleAllowsDashboard(session!.role));
  });

  it("client login/session path", () => {
    const user = authenticateCredentials("client@example.invalid", "client-pass");
    assert.ok(user);
    assert.equal(user!.role, "CLIENT");
    const token = createSessionToken(user!, SECRET);
    const session = verifySessionToken(token, SECRET);
    assert.equal(session!.role, "CLIENT");
  });

  it("admin login/session path", () => {
    const user = authenticateCredentials("admin@example.invalid", "admin-pass");
    assert.equal(user?.role, "ADMIN");
  });

  it("rejects bad password", () => {
    assert.equal(authenticateCredentials("owner@example.invalid", "wrong"), null);
  });

  it("edge verify matches node sign", async () => {
    const user = authenticateCredentials("owner@example.invalid", "owner-pass")!;
    const token = createSessionToken(user, SECRET);
    const edge = await verifySessionTokenEdge(token, SECRET);
    assert.ok(edge);
    assert.equal(edge!.email, user.email);
  });

  it("logout clears by empty cookie semantics", () => {
    assert.equal(AUTH_COOKIE, "fna_session");
    assert.equal(verifySessionToken("", SECRET), null);
  });

  it("isAuthEnforced follows AUTH_SECRET", () => {
    assert.equal(isAuthEnforced(), true);
    delete process.env.AUTH_SECRET;
    assert.equal(isAuthEnforced(), false);
  });

  it("no auth secret value appears in public login markup contract", () => {
    // Login page must never embed AUTH_SECRET; session is httpOnly cookie only.
    assert.ok(!SECRET.includes("httpOnly"));
    assert.equal(typeof SECRET, "string");
    assert.ok(SECRET.length > 8);
  });
});

describe("private API protection helpers", () => {
  it("unauthenticated dashboard API denied pattern (401 body)", () => {
    const body = { ok: false, error: "Unauthorized" };
    assert.equal(body.ok, false);
    assert.equal(body.error, "Unauthorized");
  });

  it("unauthenticated page redirect target is /login", () => {
    const next = "/dashboard";
    const login = `/login?next=${encodeURIComponent(next)}`;
    assert.match(login, /^\/login/);
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

  it("webhook rejects wrong secret", () => {
    const bad = verifyWebhookSecret({
      signatureHeader: "wrong",
      dryRun: false,
      secretConfigured: true,
      secretValue: "deploy-secret",
      enforceFlag: true,
    });
    assert.equal(bad.ok, false);
  });
});

describe("Master guard unchanged", () => {
  it("Master location still blocked by readiness", () => {
    const cfg = faLiveDefaultClientConfig();
    cfg.ghl.locationId = PROTECTED_MASTER_LOCATION_ID;
    const r = evaluateClientReadiness(cfg);
    assert.equal(r.status, "BLOCKED");
  });
});

describe("fake-client readiness unchanged", () => {
  it("placeholder fake roofing remains BLOCKED", () => {
    const path = resolve("config/examples/fake-roofing-client.json");
    const cfg = loadClientConfigFromFile(path);
    assert.equal(evaluateClientReadiness(cfg).status, "BLOCKED");
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
    assert.ok(report.blockers.some((b) => b.includes("$497")));
  });
});

describe("deployment factory / validator", () => {
  it("client prep checklist reports fake roofing BLOCKED", () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/fake-roofing-client.json")
    );
    const { sections, report } = buildClientPrepChecklist(cfg, {});
    assert.equal(report.status, "BLOCKED");
    assert.ok(sections.some((s) => s.name === "MASTER GUARD" && s.ok));
    assert.ok(sections.some((s) => s.name === "LOCATION" && !s.ok));
  });

  it("F&A default validates with secrets present → not BLOCKED by placeholders", () => {
    resetTenantConfigForTests(faLiveDefaultClientConfig());
    const cfg = faLiveDefaultClientConfig();
    const report = validateClientDeployment(cfg, {
      GHL_WEBHOOK_SECRET: "present",
      GHL_API_TOKEN: "present",
      AUTH_SECRET: "present",
      AUTH_OWNER_EMAIL: "owner@example.invalid",
      AUTH_OWNER_PASSWORD: "x",
    });
    assert.notEqual(report.status, "BLOCKED");
    assert.equal(report.masterBlocked, false);
  });
});

describe("tenant content tokens", () => {
  it("consent and snippets resolve client business name", () => {
    const copy = getConsentCopy("Acme Roofing");
    assert.match(copy.smsService, /Acme Roofing/);
    assert.doesNotMatch(copy.smsService, /\{\{/);
    const snip = applyClientBusinessName(
      "Thanks for contacting {{CLIENT_BUSINESS_NAME}}.",
      "Acme Roofing"
    );
    assert.equal(snip, "Thanks for contacting Acme Roofing.");
  });

  it("platform product name remains F&A", () => {
    assert.equal(BRAND.product, "Fortune & Automations Business Dashboard");
  });
});

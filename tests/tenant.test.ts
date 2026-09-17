/**
 * Tenant / clone-readiness tests.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BRAND } from "../src/lib/brand";
import {
  evaluateClientReadiness,
  loadClientConfigFromFile,
  parseClientConfig,
  toPublicReadinessPayload,
} from "../src/lib/onboarding";
import { assertAllowedLocationId } from "../src/lib/sync/location-guard";
import { ingestSyncPayload, createMemoryStore } from "../src/lib/sync";
import {
  FA_LIVE_LOCATION_ID,
  PROTECTED_MASTER_LOCATION_ID,
  clientBusinessName,
  configuredCalendars,
  configuredLocationId,
  configuredPipelineName,
  configuredStageNames,
  faLiveDefaultClientConfig,
  loadTenantConfigFromEnv,
  platformProductName,
  resetTenantConfigForTests,
} from "../src/lib/tenant";

const MASTER = PROTECTED_MASTER_LOCATION_ID;

beforeEach(() => {
  process.env.GHL_DRY_RUN = "true";
  process.env.ALLOW_PRODUCTION_CONTACT_WRITES = "false";
  process.env.GHL_LOCATION_ID = FA_LIVE_LOCATION_ID;
  process.env.GHL_PIPELINE_ID = BRAND.pipelineId;
  process.env.FORBIDDEN_MASTER_LOCATION_ID = MASTER;
  delete process.env.CLIENT_CONFIG_PATH;
  resetTenantConfigForTests(faLiveDefaultClientConfig());
});

describe("tenant defaults (F&A LIVE)", () => {
  it("existing F&A config loads", () => {
    const cfg = faLiveDefaultClientConfig();
    assert.equal(cfg.ghl.locationId, FA_LIVE_LOCATION_ID);
    assert.equal(cfg.ghl.pipelineId, BRAND.pipelineId);
    assert.ok(Object.keys(cfg.ghl.stageIds).length >= 10);
    assert.ok(Object.keys(cfg.ghl.calendarIds).length >= 1);
    resetTenantConfigForTests(cfg);
    assert.equal(configuredLocationId(), FA_LIVE_LOCATION_ID);
    assert.equal(clientBusinessName(), "Fortune & Automations");
    assert.equal(platformProductName(), BRAND.product);
  });

  it("F&A default readiness is PARTIAL/BLOCKED without invented owner URLs", () => {
    const report = evaluateClientReadiness(faLiveDefaultClientConfig());
    assert.notEqual(
      report.status,
      "READY",
      JSON.stringify(report.checks.filter((c) => !c.passed))
    );
  });
});

describe("second synthetic location config", () => {
  it("loads and becomes READY when complete", () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/synthetic-ready-client.json")
    );
    assert.equal(cfg.ghl.locationId, "loc_synth_ready_001");
    assert.equal(cfg.business.businessName, "Acme Ready Synth");
    const report = evaluateClientReadiness(cfg);
    assert.equal(report.status, "READY");
    resetTenantConfigForTests(cfg);
    process.env.GHL_LOCATION_ID = cfg.ghl.locationId;
    process.env.GHL_PIPELINE_ID = cfg.ghl.pipelineId;
    assert.equal(configuredLocationId(), "loc_synth_ready_001");
    assert.equal(clientBusinessName(), "Acme Ready Synth");
    assert.ok(configuredStageNames().includes("New Lead"));
    assert.ok(configuredCalendars().some((c) => c.name === "Discovery Call"));
  });
});

describe("Master guard absolute", () => {
  it("Master config rejected by readiness", () => {
    const cfg = parseClientConfig({
      ...faLiveDefaultClientConfig(),
      ghl: { ...faLiveDefaultClientConfig().ghl, locationId: MASTER },
    });
    const report = evaluateClientReadiness(cfg);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.masterGuard.locationIsMaster, true);
  });

  it("Master rejected by location guard even if env tries to match", () => {
    process.env.GHL_LOCATION_ID = MASTER;
    assert.throws(() => assertAllowedLocationId(MASTER), /Master/);
  });

  it("loadTenantConfigFromEnv refuses Master location override", () => {
    assert.throws(
      () =>
        loadTenantConfigFromEnv({
          ...process.env,
          GHL_LOCATION_ID: MASTER,
        }),
      /Master/
    );
  });
});

describe("branding separation", () => {
  it("platform F&A branding remains while client business changes", () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/synthetic-ready-client.json")
    );
    resetTenantConfigForTests(cfg);
    assert.equal(platformProductName(), "Fortune & Automations Business Dashboard");
    assert.equal(clientBusinessName(), "Acme Ready Synth");
    assert.equal(configuredPipelineName(), "Acme Ready Sales Pipeline");
  });
});

describe("fake roofing readiness", () => {
  it("placeholder fake-client config = BLOCKED", () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/fake-roofing-client.json")
    );
    const report = evaluateClientReadiness(cfg);
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.blocked >= 1);
  });

  it("completed fake-client-shaped config = READY", () => {
    const report = evaluateClientReadiness(
      loadClientConfigFromFile(resolve("config/examples/synthetic-ready-client.json"))
    );
    assert.equal(report.status, "READY");
  });
});

describe("readiness API payload secrets", () => {
  it("no secret values returned", () => {
    const payload = toPublicReadinessPayload(
      evaluateClientReadiness(faLiveDefaultClientConfig())
    );
    const text = JSON.stringify(payload);
    assert.equal(/webhookSecret"\s*:/.test(text), false);
    assert.equal(/GHL_API_TOKEN|SUPABASE_SERVICE_ROLE|password/i.test(text), false);
  });
});

describe("configured location webhook guard", () => {
  it("wrong location webhook rejected", async () => {
    const store = createMemoryStore();
    const payload = {
      event: "lead.created",
      locationId: "wrong_loc",
      contactId: "c1",
      idempotencyKey: "w1",
    };
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "wrong_location");
  });

  it("configured location webhook accepted by guard", async () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/synthetic-ready-client.json")
    );
    resetTenantConfigForTests(cfg);
    process.env.GHL_LOCATION_ID = cfg.ghl.locationId;
    process.env.GHL_PIPELINE_ID = cfg.ghl.pipelineId;
    const store = createMemoryStore();
    const payload = {
      event: "lead.created",
      locationId: cfg.ghl.locationId,
      contactId: "c_ok",
      firstName: "Test",
      idempotencyKey: "ok-1",
    };
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, true);
  });

  it("Master webhook always rejected", async () => {
    const store = createMemoryStore();
    const payload = {
      event: "lead.created",
      locationId: MASTER,
      contactId: "c1",
      idempotencyKey: "m1",
    };
    const result = await ingestSyncPayload(JSON.stringify(payload), payload, { store });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "master_refused");
  });
});

describe("pipeline/calendar config rendering sources", () => {
  it("client pipeline stages come from config", () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/synthetic-ready-client.json")
    );
    resetTenantConfigForTests(cfg);
    assert.deepEqual(configuredStageNames(), ["New Lead", "Won", "Lost"]);
  });

  it("client calendars come from config", () => {
    const cfg = loadClientConfigFromFile(
      resolve("config/examples/synthetic-ready-client.json")
    );
    resetTenantConfigForTests(cfg);
    const cals = configuredCalendars();
    assert.ok(cals.some((c) => c.id === "cal_synth_primary"));
  });
});

describe("fixtures present", () => {
  it("fake roofing file is unmistakably synthetic", () => {
    const raw = readFileSync(resolve("config/examples/fake-roofing-client.json"), "utf8");
    assert.ok(raw.includes("F&A Roofing Test"));
    assert.ok(raw.includes("REPLACE_ME"));
    assert.ok(raw.includes("example.invalid"));
  });
});

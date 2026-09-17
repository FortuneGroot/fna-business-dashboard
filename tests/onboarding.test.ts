/**
 * Onboarding readiness tests — no network writes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BRAND } from "../src/lib/brand";
import {
  emptyClientConfig,
  evaluateClientReadiness,
  looksLikePlaceholder,
  parseClientConfig,
  toPublicReadinessPayload,
  type ClientConfig,
} from "../src/lib/onboarding";

function goodConfig(over: Partial<ClientConfig> = {}): ClientConfig {
  const base = emptyClientConfig();
  const merged = parseClientConfig({
    ...base,
    clientSlug: "acme-demo",
    business: {
      ...base.business,
      businessName: "Acme Services",
      legalBusinessName: "Acme Services LLC",
      industry: "Services",
      address: "1 Main St",
      city: "Hartford",
      state: "CT",
      zip: "06103",
      timezone: "US/Eastern",
      businessPhone: "+18605550100",
      supportEmail: "support@acme-services.test",
      leadNotificationEmail: "leads@acme-services.test",
      websiteUrl: "https://www.acme-services.test",
      logoUrl: "https://cdn.acme-services.test/logo.png",
    },
    ghl: {
      ...base.ghl,
      locationId: "loc_client_abc123",
      pipelineId: "pipe_client_abc123",
      pipelineName: "Acme Sales Pipeline",
      stageIds: {
        "New Lead": "stage_new",
        "Won": "stage_won",
        "Lost": "stage_lost",
      },
      bookingCalendarId: "cal_client_abc123",
      calendarIds: {
        primaryBooking: "cal_client_abc123",
        "Discovery Call": "cal_client_abc123",
      },
      bookingUrl: "https://book.acme-services.test/discovery",
      rescheduleUrl: "https://book.acme-services.test/reschedule",
      reviewUrl: "https://g.page/r/acme-services-test",
      assignedUserIds: ["user_owner_1"],
      phoneNumber: "+18605550100",
      domain: "acme-services.test",
    },
    branding: {
      primaryColor: "#445367",
      secondaryColor: "#BCA077",
      backgroundColor: "#F3EFE9",
      logo: "https://cdn.acme-services.test/logo.png",
      favicon: "https://cdn.acme-services.test/favicon.ico",
    },
    channels: {
      ...base.channels,
      calendarEnabled: true,
      emailEnabled: true,
      reviewEnabled: true,
    },
    sync: {
      webhookDestination: "https://app-preview.acme-services.test/api/webhooks/ghl",
      webhookSecretConfigured: true,
      locationGuard: true,
      masterGuard: true,
    },
    safety: {
      allowProductionWrites: false,
      dryRun: true,
      fakeContactOnly: true,
    },
    ...over,
  });
  return merged;
}

describe("looksLikePlaceholder", () => {
  it("detects REPLACE_ME and example hosts", () => {
    assert.equal(looksLikePlaceholder("REPLACE_ME_LOCATION_ID"), true);
    assert.equal(looksLikePlaceholder("https://example.com/booking"), true);
    assert.equal(looksLikePlaceholder("https://book.acme-services.test/x"), false);
  });
});

describe("evaluateClientReadiness", () => {
  it("good config -> READY", () => {
    const report = evaluateClientReadiness(goodConfig());
    assert.equal(report.status, "READY");
    assert.equal(report.blocked, 0);
    assert.equal(report.partial, 0);
    assert.equal(report.masterGuard.passed, true);
    assert.equal(report.highlevelPlan, "$297 Unlimited");
    assert.ok(report.notDependentOn.includes("$497 Agency Pro"));
  });

  it("missing calendar -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        ghl: { ...goodConfig().ghl, bookingCalendarId: "" },
        channels: { ...goodConfig().channels, calendarEnabled: false },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("ghl.bookingCalendarId"));
  });

  it("Master location -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        ghl: { ...goodConfig().ghl, locationId: BRAND.forbiddenMasterId },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.masterGuard.locationIsMaster, true);
    assert.equal(report.masterGuard.passed, false);
  });

  it("missing webhook secret -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        sync: { ...goodConfig().sync, webhookSecretConfigured: false },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("sync.webhookSecretConfigured"));
  });

  it("placeholder URL -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        ghl: { ...goodConfig().ghl, bookingUrl: "https://REPLACE_ME/booking" },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("ghl.bookingUrl"));
  });

  it("missing support email -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        business: { ...goodConfig().business, supportEmail: "" },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("business.supportEmail"));
  });

  it("missing user mapping -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        ghl: { ...goodConfig().ghl, assignedUserIds: [] },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("ghl.assignedUserIds"));
  });

  it("$497 dependency flag -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        forbiddenDependencies: {
          requiresAgencyPro497: true,
          requiresAdvancedOAuth: false,
          requiresAgencyCrmApi: false,
          requiresWhiteLabelMobileAddon: false,
        },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("forbiddenDependencies"));
  });

  it("missing stageIds -> BLOCKED", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        ghl: { ...goodConfig().ghl, stageIds: {} },
      })
    );
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.missingFields.includes("ghl.stageIds"));
  });

  it("synthetic email -> PARTIAL (not READY)", () => {
    const report = evaluateClientReadiness(
      goodConfig({
        business: {
          ...goodConfig().business,
          supportEmail: "support@example.invalid",
          leadNotificationEmail: "leads@example.invalid",
        },
      })
    );
    assert.equal(report.status, "PARTIAL");
    assert.ok(report.partial >= 1);
    assert.equal(report.blocked, 0);
  });
});

describe("toPublicReadinessPayload", () => {
  it("returns no secrets", () => {
    const payload = toPublicReadinessPayload(evaluateClientReadiness(goodConfig()));
    const text = JSON.stringify(payload);
    assert.equal(/webhookSecret"\s*:/.test(text), false);
    assert.equal(/GHL_API_TOKEN|SUPABASE_SERVICE_ROLE|password|Bearer /i.test(text), false);
    assert.ok("totalChecks" in payload);
    assert.ok("passed" in payload);
    assert.ok("partial" in payload);
    assert.ok("blocked" in payload);
    assert.ok("missingFields" in payload);
    assert.ok("masterGuard" in payload);
  });
});

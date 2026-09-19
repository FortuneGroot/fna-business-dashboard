/**
 * Deployment tenant = ONE client config per deployment.
 * Platform product branding stays in brand.ts (Fortune & Automations Business Dashboard).
 * Client business identity/location/pipeline/calendars resolve here.
 *
 * Default (no CLIENT_CONFIG_PATH): F&A LIVE Preview values.
 * Absolute: protected Master location is never allowed — not overridable.
 */
import "server-only";
import { BRAND } from "@/lib/brand";
import type { ClientConfig } from "@/lib/onboarding/types";
import { emptyClientConfig, parseClientConfig } from "@/lib/onboarding";
import {
  FA_LIVE_LOCATION_ID,
  FA_LIVE_PIPELINE_ID,
  PROTECTED_MASTER_LOCATION_ID,
} from "@/lib/master-guard";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export {
  FA_LIVE_LOCATION_ID,
  FA_LIVE_PIPELINE_ID,
  PROTECTED_MASTER_LOCATION_ID,
} from "@/lib/master-guard";

const FA_STAGE_ORDER = [
  "New Lead",
  "Attempting Contact",
  "Connected",
  "Qualified",
  "Appointment Booked",
  "Appointment Completed",
  "Estimate / Proposal Sent",
  "Follow-Up",
  "Decision Pending",
  "Won",
  "Lost",
  "Long-Term Nurture",
] as const;

/** Stable name-keyed stage tokens for F&A LIVE until explicit GHL stage UUIDs are captured. */
function faLiveStageIds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FA_STAGE_ORDER) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    out[name] = `fa-live-stage-${slug}`;
  }
  return out;
}

const FA_CALENDARS = [
  { name: "Discovery Call", duration: "30 min" },
  { name: "Website Consultation", duration: "30 min" },
  { name: "Business Consultation", duration: "30 min" },
  { name: "Client / Project Meeting", duration: "30 min" },
  { name: "Core Booking", duration: "1 hr" },
] as const;

function faLiveCalendarIds(): Record<string, string> {
  const out: Record<string, string> = { primaryBooking: "fa-live-cal-discovery-call" };
  for (const c of FA_CALENDARS) {
    const slug = c.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    out[c.name] = `fa-live-cal-${slug}`;
  }
  return out;
}

/** Embedded default for existing F&A Preview — keeps current behavior without CLIENT_CONFIG_PATH. */
export function faLiveDefaultClientConfig(): ClientConfig {
  const base = emptyClientConfig();
  return parseClientConfig({
    ...base,
    clientSlug: "fa-live",
    highlevelPlan: "$297 Unlimited",
    notes: "Default F&A LIVE deployment config (Preview). Not the protected Master.",
    forbiddenDependencies: {
      requiresAgencyPro497: false,
      requiresAdvancedOAuth: false,
      requiresAgencyCrmApi: false,
      requiresWhiteLabelMobileAddon: false,
    },
    business: {
      ...base.business,
      businessName: "Fortune & Automations",
      legalBusinessName: "Fortune & Finance LLC",
      industry: "Automation / Websites / Branding / Systems",
      timezone: BRAND.timezone,
      businessPhone: BRAND.supportPhoneRecovered,
      supportEmail: BRAND.supportEmailRecovered,
      leadNotificationEmail: BRAND.supportEmailRecovered,
      websiteUrl: BRAND.website,
      logoUrl: "",
      address: "",
      city: "",
      state: "",
      zip: "",
    },
    ghl: {
      ...base.ghl,
      locationId: FA_LIVE_LOCATION_ID,
      pipelineId: FA_LIVE_PIPELINE_ID,
      pipelineName: BRAND.pipelineName,
      stageIds: faLiveStageIds(),
      bookingCalendarId: "fa-live-cal-discovery-call",
      calendarIds: faLiveCalendarIds(),
      bookingUrl: "",
      rescheduleUrl: "",
      reviewUrl: "",
      assignedUserIds: ["fa-live-user-owner"],
      phoneNumber: BRAND.supportPhoneRecovered,
      domain: BRAND.appHost,
    },
    branding: {
      primaryColor: BRAND.colors.blue,
      secondaryColor: BRAND.colors.gold,
      backgroundColor: BRAND.colors.cream,
      logo: "",
      favicon: "/favicon.ico",
    },
    channels: {
      smsEnabled: false,
      emailEnabled: true,
      voiceEnabled: false,
      reviewEnabled: true,
      calendarEnabled: true,
    },
    ai: {
      conversationAiEnabled: false,
      voiceAiEnabled: false,
      aiBusinessName: "Fortune & Automations",
      aiGreeting: "Thanks for contacting Fortune & Automations.",
      aiEscalationTarget: "fa-live-user-owner",
    },
    sync: {
      webhookDestination: "",
      webhookSecretConfigured: true,
      locationGuard: true,
      masterGuard: true,
    },
    payments: { stripeConnected: false, paymentsEnabled: false },
    safety: {
      allowProductionWrites: false,
      dryRun: true,
      fakeContactOnly: true,
    },
  });
}

const GLOBAL_TENANT = "__fna_tenant_config__";

type GlobalTenant = typeof globalThis & { [GLOBAL_TENANT]?: ClientConfig };

function assertNotMasterLocation(locationId: string): void {
  if (locationId === PROTECTED_MASTER_LOCATION_ID) {
    throw new Error("Protected Master location refused (absolute; not overridable)");
  }
}

export function loadTenantConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): ClientConfig {
  const path = (env.CLIENT_CONFIG_PATH || "").trim();
  let config: ClientConfig;
  if (path) {
    const abs = resolve(cwd, path);
    if (!existsSync(abs)) {
      throw new Error(`CLIENT_CONFIG_PATH not found: ${abs}`);
    }
    config = parseClientConfig(JSON.parse(readFileSync(abs, "utf8")));
  } else {
    config = faLiveDefaultClientConfig();
  }

  // Env must MATCH config when both are set — never silently override.
  const envLoc = (env.GHL_LOCATION_ID || "").trim();
  const envPipe = (env.GHL_PIPELINE_ID || "").trim();
  const configLoc = (config.ghl.locationId || "").trim();
  const configPipe = (config.ghl.pipelineId || "").trim();

  if (envLoc) assertNotMasterLocation(envLoc);
  assertNotMasterLocation(configLoc);

  if (path && envLoc && configLoc && envLoc !== configLoc) {
    throw new Error(
      `GHL_LOCATION_ID (${envLoc}) must match CLIENT_CONFIG_PATH locationId (${configLoc}). Refusing silent override.`
    );
  }
  if (path && envPipe && configPipe && envPipe !== configPipe) {
    throw new Error(
      `GHL_PIPELINE_ID (${envPipe}) must match CLIENT_CONFIG_PATH pipelineId (${configPipe}). Refusing silent override.`
    );
  }

  // When no CLIENT_CONFIG_PATH, env may supply location/pipeline (still Master-blocked).
  if (!path && envLoc) {
    config = parseClientConfig({
      ...config,
      ghl: { ...config.ghl, locationId: envLoc },
    });
  }
  if (!path && envPipe) {
    config = parseClientConfig({
      ...config,
      ghl: { ...config.ghl, pipelineId: envPipe },
    });
  }

  assertNotMasterLocation(config.ghl.locationId);
  if (config.sync) config.sync.masterGuard = true;
  return config;
}

export function getTenantConfig(): ClientConfig {
  const g = globalThis as GlobalTenant;
  if (!g[GLOBAL_TENANT]) {
    g[GLOBAL_TENANT] = loadTenantConfigFromEnv();
  }
  return g[GLOBAL_TENANT]!;
}

export function resetTenantConfigForTests(config?: ClientConfig): void {
  const g = globalThis as GlobalTenant;
  g[GLOBAL_TENANT] = config;
}

export function configuredLocationId(): string {
  const id = getTenantConfig().ghl.locationId.trim();
  assertNotMasterLocation(id);
  return id;
}

export function configuredPipelineId(): string {
  return getTenantConfig().ghl.pipelineId.trim();
}

export function configuredPipelineName(): string {
  return getTenantConfig().ghl.pipelineName || "Sales Pipeline";
}

export function configuredStageNames(): string[] {
  const ids = getTenantConfig().ghl.stageIds || {};
  const keys = Object.keys(ids);
  if (keys.length) return keys;
  return [...FA_STAGE_ORDER];
}

export type TenantCalendar = { name: string; id: string; duration?: string };

export function configuredCalendars(): TenantCalendar[] {
  const cfg = getTenantConfig();
  const map = cfg.ghl.calendarIds || {};
  const primary = cfg.ghl.bookingCalendarId;
  const names = Object.keys(map).filter((k) => k !== "primaryBooking");
  if (!names.length && primary) {
    return [{ name: "Primary booking", id: primary, duration: "—" }];
  }
  if (!names.length) {
    return FA_CALENDARS.map((c) => ({
      name: c.name,
      id: map[c.name] || `fa-live-cal-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      duration: c.duration,
    }));
  }
  return names.map((name) => ({
    name,
    id: map[name],
    duration: FA_CALENDARS.find((c) => c.name === name)?.duration || "—",
  }));
}

export function clientBusinessName(): string {
  return getTenantConfig().business.businessName || BRAND.name;
}

export function clientLegalName(): string {
  return getTenantConfig().business.legalBusinessName || BRAND.legal;
}

export function clientBrandColors(): {
  primary: string;
  secondary: string;
  background: string;
} {
  const b = getTenantConfig().branding;
  return {
    primary: b.primaryColor || BRAND.colors.blue,
    secondary: b.secondaryColor || BRAND.colors.gold,
    background: b.backgroundColor || BRAND.colors.cream,
  };
}

export function clientSupportEmail(): string {
  return getTenantConfig().business.supportEmail || "";
}

export function clientLeadNotificationEmail(): string {
  return getTenantConfig().business.leadNotificationEmail || "";
}

export function clientLogoUrl(): string {
  return getTenantConfig().business.logoUrl || getTenantConfig().branding.logo || "";
}

export function clientBookingUrl(): string {
  return getTenantConfig().ghl.bookingUrl || "";
}

export function clientReviewUrl(): string {
  return getTenantConfig().ghl.reviewUrl || "";
}

export function clientZip(): string {
  return getTenantConfig().business.zip || "";
}

/** Platform product name — never swap this for client business name. */
export function platformProductName(): string {
  return BRAND.product;
}

export function platformBrandName(): string {
  return BRAND.name;
}

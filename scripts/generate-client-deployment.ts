/**
 * Generate a NON-SECRET deployment manifest from a client config JSON.
 * Secrets are listed as OWNER REQUIRED flags only — never printed.
 *
 * Usage:
 *   npx tsx scripts/generate-client-deployment.ts config/examples/fake-roofing-client.json
 *   npx tsx scripts/generate-client-deployment.ts config/path.json --out generated/client.env.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadClientConfigFromFile } from "../src/lib/onboarding";
import { PROTECTED_MASTER_LOCATION_ID } from "../src/lib/tenant";
import { looksLikePlaceholder } from "../src/lib/onboarding";

function main() {
  const raw = process.argv.slice(2).filter((a) => a !== "--");
  let outPath = "";
  const args: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--out") {
      outPath = raw[i + 1] || "";
      i++;
      continue;
    }
    if (raw[i].endsWith(".ts") && raw[i].includes("generate-client")) continue;
    args.push(raw[i]);
  }
  const configPath = args.find((a) => a.endsWith(".json")) || args[0];
  if (!configPath || configPath.startsWith("-")) {
    console.error("Usage: generate-client-deployment.ts <client.json> [--out path]");
    process.exit(2);
  }

  const abs = resolve(configPath);
  const config = loadClientConfigFromFile(abs);

  const manifest = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    sourceConfig: abs,
    clientSlug: config.clientSlug,
    highlevelPlan: config.highlevelPlan,
    CLIENT_BUSINESS_NAME: config.business.businessName,
    CLIENT_LEGAL_BUSINESS_NAME: config.business.legalBusinessName,
    CLIENT_LOCATION_ID: config.ghl.locationId,
    CLIENT_PIPELINE_ID: config.ghl.pipelineId,
    CLIENT_STAGE_CONFIG: config.ghl.stageIds,
    CLIENT_CALENDAR_CONFIG: {
      bookingCalendarId: config.ghl.bookingCalendarId,
      calendarIds: config.ghl.calendarIds,
    },
    CLIENT_SUPPORT_EMAIL: config.business.supportEmail,
    CLIENT_LEAD_NOTIFICATION_EMAIL: config.business.leadNotificationEmail,
    CLIENT_LOGO_URL: config.business.logoUrl || config.branding.logo,
    CLIENT_BOOKING_URL: config.ghl.bookingUrl,
    CLIENT_RESCHEDULE_URL: config.ghl.rescheduleUrl,
    CLIENT_REVIEW_URL: config.ghl.reviewUrl,
    CLIENT_ZIP: config.business.zip,
    CLIENT_BRAND_COLORS: {
      primary: config.branding.primaryColor,
      secondary: config.branding.secondaryColor,
      background: config.branding.backgroundColor,
    },
    FORBIDDEN_MASTER_LOCATION_ID: PROTECTED_MASTER_LOCATION_ID,
    GHL_DRY_RUN: config.safety.dryRun !== false,
    ALLOW_PRODUCTION_CONTACT_WRITES: config.safety.allowProductionWrites === true,
    FAKE_CONTACT_ONLY: config.safety.fakeContactOnly !== false,
    CLIENT_CONFIG_PATH: abs,
    suggestedEnv: {
      GHL_LOCATION_ID: config.ghl.locationId,
      GHL_PIPELINE_ID: config.ghl.pipelineId,
      FORBIDDEN_MASTER_LOCATION_ID: PROTECTED_MASTER_LOCATION_ID,
      GHL_DRY_RUN: String(config.safety.dryRun !== false),
      ALLOW_PRODUCTION_CONTACT_WRITES: String(config.safety.allowProductionWrites === true),
      FAKE_CONTACT_ONLY: String(config.safety.fakeContactOnly !== false),
      CLIENT_CONFIG_PATH: abs,
      GHL_WEBHOOK_ENFORCE_SECRET: "true",
    },
    ownerRequiredSecrets: {
      GHL_API_TOKEN: "MISSING — set in Vercel/env (never commit)",
      GHL_WEBHOOK_SECRET: "MISSING — per-deployment secret (never commit, never print)",
      SUPABASE_SERVICE_ROLE_KEY: "OPTIONAL until Postgres durable store enabled",
      AUTH_SECRET: "MISSING — required to enforce dashboard login",
      AUTH_OWNER_EMAIL: "MISSING — set owner login email",
      AUTH_OWNER_PASSWORD: "MISSING — set owner login password",
      AUTH_ADMIN_EMAIL: "OPTIONAL",
      AUTH_ADMIN_PASSWORD: "OPTIONAL",
      AUTH_CLIENT_EMAIL: "OPTIONAL — client user for this deployment",
      AUTH_CLIENT_PASSWORD: "OPTIONAL",
    },
    secretPresenceHints: {
      note: "Presence only — values never included in this manifest",
      placeholdersDetected: [
        looksLikePlaceholder(config.ghl.locationId) && "CLIENT_LOCATION_ID",
        looksLikePlaceholder(config.ghl.pipelineId) && "CLIENT_PIPELINE_ID",
        Object.values(config.ghl.stageIds || {}).some(looksLikePlaceholder) && "CLIENT_STAGE_CONFIG",
        Object.values(config.ghl.calendarIds || {}).some(looksLikePlaceholder) &&
          "CLIENT_CALENDAR_CONFIG",
      ].filter(Boolean),
    },
  };

  const json = JSON.stringify(manifest, null, 2);
  if (/pit-[A-Za-z0-9_-]{12,}/i.test(json) || /Bearer\s+[A-Za-z0-9._-]{20,}/i.test(json)) {
    console.error("Refusing to emit manifest that appears to contain secret values.");
    process.exit(2);
  }

  if (outPath) {
    const dest = resolve(outPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, json, "utf8");
    console.log(`WROTE ${dest}`);
  } else {
    console.log(json);
  }

  console.error("--- OWNER REQUIRED (set in Vercel; never print values) ---");
  for (const [k, v] of Object.entries(manifest.ownerRequiredSecrets)) {
    console.error(`${k}: ${v}`);
  }
}

main();

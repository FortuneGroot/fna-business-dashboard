import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { legacyOnlyEndpoint } from "@/lib/auth/legacy-only";
import { loadEnv } from "@/lib/env";
import {
  getStorageMode,
  getSyncStore,
  isDatabaseConfigured,
} from "@/lib/sync";
import {
  PROTECTED_MASTER_LOCATION_ID,
  configuredLocationId,
  clientBusinessName,
} from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Sync-layer health for the $297 webhook architecture.
 * Does not call HighLevel CRM read APIs.
 * Never exposes secret values.
 * ADMIN+ only.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireApiRole(req, "ADMIN");
  if (error) return error;
  const unavailable = legacyOnlyEndpoint();
  if (unavailable) return unavailable;
  const env = loadEnv();
  const store = getSyncStore();
  const stats = await store.stats();
  const enforceFlag =
    (process.env.GHL_WEBHOOK_ENFORCE_SECRET || "").toLowerCase() === "true" ||
    (process.env.VERCEL_ENV || "").trim().toLowerCase() === "production";
  const storageMode = getStorageMode();
  const webhookSecretEnforced = enforceFlag || !env.dryRun;
  let configuredLocation = env.locationId;
  try {
    configuredLocation = configuredLocationId();
  } catch {
    /* keep env */
  }

  return NextResponse.json({
    ok: true,
    locationId: env.locationId,
    configuredLocationId: configuredLocation,
    clientBusinessName: clientBusinessName(),
    matchesConfigured: env.locationId === configuredLocation,
    storageMode,
    databaseConfigured: isDatabaseConfigured(),
    masterGuard: {
      masterBlocked: true,
      locationIsMaster: env.locationId === PROTECTED_MASTER_LOCATION_ID,
      overridable: false,
    },
    webhookSecretConfigured: env.webhookSecretPresent,
    webhookSecretEnforced,
    webhook: {
      endpoint: "/api/webhooks/ghl",
      configured: true,
      secretConfigured: env.webhookSecretPresent,
      enforceSecret: webhookSecretEnforced,
      developmentModeAllowed: env.dryRun && !env.webhookSecretPresent && !enforceFlag,
    },
    dryRun: env.dryRun,
    allowProductionWrites: env.allowProductionWrites,
    fakeContactOnly: env.fakeContactOnly,
    lastEventAt: stats.lastEventAt || null,
    contactsCount: stats.contactsSynced,
    opportunitiesCount: stats.opportunitiesSynced,
    appointmentsCount: stats.appointmentsSynced,
    conversationEventsCount: stats.conversationEvents,
    eventCount: stats.auditEvents,
    sync: {
      storageMode,
      databaseConfigured: isDatabaseConfigured(),
      lastEventTimestamp: stats.lastEventAt || null,
      contactsSyncedCount: stats.contactsSynced,
      opportunitiesSyncedCount: stats.opportunitiesSynced,
      appointmentsSyncedCount: stats.appointmentsSynced,
      conversationEventsCount: stats.conversationEvents,
      taskEventsCount: stats.taskEvents,
      reviewEventsCount: stats.reviewEvents,
      auditEventsCount: stats.auditEvents,
      persistence:
        storageMode === "postgres"
          ? "supabase-postgres (durable)"
          : "in-memory (process-local fallback)",
    },
  });
}

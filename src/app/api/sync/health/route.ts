import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import { loadEnv } from "@/lib/env";
import {
  getStorageMode,
  getSyncStore,
  isDatabaseConfigured,
} from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * Sync-layer health for the $297 webhook architecture.
 * Does not call HighLevel CRM read APIs.
 * Never exposes secret values.
 */
export async function GET() {
  const env = loadEnv();
  const store = getSyncStore();
  const stats = await store.stats();
  const enforceFlag =
    (process.env.GHL_WEBHOOK_ENFORCE_SECRET || "").toLowerCase() === "true";
  const storageMode = getStorageMode();
  const webhookSecretEnforced = enforceFlag || !env.dryRun;

  return NextResponse.json({
    ok: true,
    locationId: env.locationId,
    liveLocationId: BRAND.liveLocationId,
    matchesLive: env.locationId === BRAND.liveLocationId,
    storageMode,
    databaseConfigured: isDatabaseConfigured(),
    masterGuard: {
      forbiddenMasterId: env.forbiddenMasterId,
      masterBlocked: true,
      locationIsMaster: env.locationId === env.forbiddenMasterId,
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

import { NextResponse } from "next/server";
import { BRAND } from "@/lib/brand";
import { loadEnv } from "@/lib/env";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

/**
 * Sync-layer health for the $297 webhook architecture.
 * Does not call HighLevel CRM read APIs.
 * Never exposes secret values.
 */
export async function GET() {
  const env = loadEnv();
  const stats = getSyncStore().stats();
  const enforceFlag =
    (process.env.GHL_WEBHOOK_ENFORCE_SECRET || "").toLowerCase() === "true";

  return NextResponse.json({
    ok: true,
    locationId: env.locationId,
    liveLocationId: BRAND.liveLocationId,
    matchesLive: env.locationId === BRAND.liveLocationId,
    masterGuard: {
      forbiddenMasterId: env.forbiddenMasterId,
      masterBlocked: true,
      locationIsMaster: env.locationId === env.forbiddenMasterId,
    },
    webhook: {
      endpoint: "/api/webhooks/ghl",
      configured: true,
      secretConfigured: env.webhookSecretPresent,
      enforceSecret: enforceFlag || !env.dryRun,
      developmentModeAllowed: env.dryRun && !env.webhookSecretPresent && !enforceFlag,
    },
    dryRun: env.dryRun,
    allowProductionWrites: env.allowProductionWrites,
    fakeContactOnly: env.fakeContactOnly,
    sync: {
      lastEventTimestamp: stats.lastEventAt || null,
      contactsSyncedCount: stats.contactsSynced,
      opportunitiesSyncedCount: stats.opportunitiesSynced,
      appointmentsSyncedCount: stats.appointmentsSynced,
      conversationEventsCount: stats.conversationEvents,
      taskEventsCount: stats.taskEvents,
      reviewEventsCount: stats.reviewEvents,
      auditEventsCount: stats.auditEvents,
      persistence: "in-memory (process-local); recommend Postgres for multi-instance production",
    },
  });
}

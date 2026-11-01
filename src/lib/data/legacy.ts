import "server-only";
import { getSyncStore } from "@/lib/sync";
import {
  clientBookingUrl,
  clientBusinessName,
  clientLegalName,
  clientReviewUrl,
  clientSupportEmail,
  configuredCalendars,
  configuredPipelineName,
  configuredStageNames,
  getTenantConfig,
} from "@/lib/tenant";
import { looksLikePlaceholderCalendars, looksLikePlaceholderStages } from "@/lib/tenant-ui";
import type { DashboardReader, DataSource, WorkspaceView } from "./types";

/** AUTH_PROVIDER=legacy: the deployment's sync store, unchanged. */
export function legacyReader(): DashboardReader {
  const store = getSyncStore();
  return {
    native: false,
    source: "sync-store",
    storageMode: store.storageMode,
    summary: () => store.summary(),
    waitingForSync: async () => (await store.summary()).waitingForSync,
    listContacts: () => store.listContacts(),
    listOpportunities: () => store.listOpportunities(),
    listAppointments: () => store.listAppointments(),
    listConversationEvents: (limit) => store.listConversationEvents(limit),
    listTaskEvents: (limit) => store.listTaskEvents(limit),
    listReviewEvents: (limit) => store.listReviewEvents(limit),
    listAuditEvents: (limit) => store.listAuditEvents(limit),
  };
}

/** AUTH_PROVIDER=legacy: the deployment's client config, unchanged. */
export function legacyWorkspaceView(): WorkspaceView {
  const cfg = getTenantConfig();
  return {
    businessName: clientBusinessName(),
    legalName: clientLegalName(),
    timezone: cfg.business.timezone,
    industry: cfg.business.industry,
    supportEmail: clientSupportEmail() || cfg.business.supportEmail || "",
    phone: cfg.business.businessPhone || cfg.ghl.phoneNumber || "",
    website: cfg.business.websiteUrl || "",
    bookingUrl: clientBookingUrl(),
    reviewUrl: clientReviewUrl(),
    pipelineName: configuredPipelineName(),
    stageNames: configuredStageNames(),
    stages: [],
    stagesConfigured: !looksLikePlaceholderStages(),
    calendars: configuredCalendars().map((c) => ({ id: c.id, name: c.name, duration: c.duration || "—" })),
    calendarsConfigured: !looksLikePlaceholderCalendars(),
  };
}

export function legacyDataSource(): DataSource {
  return {
    native: false,
    reader: legacyReader(),
    workspace: async () => legacyWorkspaceView(),
    stageTotals: async () => new Map(),
    can: () => false,
  };
}

import "server-only";
import { legacyWorkspaceView } from "@/lib/legacy/deployment";
import { getLegacySnapshotStore } from "@/lib/legacy/snapshot";
import type { DashboardReader, DataSource } from "./types";

export { legacyWorkspaceView };

/** AUTH_PROVIDER=legacy: the deployment's frozen sync snapshot, read-only. */
export function legacyReader(): DashboardReader {
  const store = getLegacySnapshotStore();
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

export function legacyDataSource(): DataSource {
  return {
    native: false,
    reader: legacyReader(),
    workspace: async () => legacyWorkspaceView(),
    stageTotals: async () => new Map(),
    can: () => false,
  };
}

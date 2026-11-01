import "server-only";
import { listActivity } from "./activity";
import { listAppointments } from "./calendars";
import { listContacts } from "./contacts";
import { listConversationEvents } from "./conversations";
import { listOpportunities } from "./pipeline";
import type { DataScope } from "./query";
import { nativeSummary, nativeWaitingForSync } from "./reports";
import { listReviewEvents } from "./reviews";
import { listTaskEvents } from "./tasks";
import type { DashboardReader, DataSource, WorkspaceView } from "./types";
import { loadWorkspaceView } from "./workspace";

export function nativeReader(scope: DataScope): DashboardReader {
  return {
    native: true,
    source: "workspace",
    storageMode: "postgres",
    summary: () => nativeSummary(scope),
    waitingForSync: () => nativeWaitingForSync(scope),
    listContacts: () => listContacts(scope),
    listOpportunities: () => listOpportunities(scope),
    listAppointments: () => listAppointments(scope),
    listConversationEvents: (limit) => listConversationEvents(scope, limit),
    listTaskEvents: (limit) => listTaskEvents(scope, limit),
    listReviewEvents: (limit) => listReviewEvents(scope, limit),
    listAuditEvents: (limit) => listActivity(scope, limit),
  };
}

export function nativeDataSource(scope: DataScope): DataSource {
  let view: Promise<WorkspaceView> | undefined;
  return {
    native: true,
    reader: nativeReader(scope),
    workspace: () => (view ??= loadWorkspaceView(scope)),
    can: (permission) => scope.ctx.permissions.includes(permission),
  };
}

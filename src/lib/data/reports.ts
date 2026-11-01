import "server-only";
import type { DashboardSummary } from "@/lib/sync/types";
import { centsToAmount, latestTimestamp } from "./dashboard-adapters";
import { openValueCents } from "./pipeline";
import { countWorkspace, fromWorkspace, rows, total, type DataScope } from "./query";

async function counts(scope: DataScope) {
  const [contactsCount, opportunitiesCount, appointmentsCount, conversationEventsCount] = await Promise.all([
    total(countWorkspace(scope, "contacts").is("deleted_at", null), "contacts"),
    total(countWorkspace(scope, "opportunities").is("deleted_at", null), "opportunities"),
    total(countWorkspace(scope, "appointments").is("deleted_at", null), "appointments"),
    total(countWorkspace(scope, "messages"), "messages"),
  ]);
  return { contactsCount, opportunitiesCount, appointmentsCount, conversationEventsCount };
}

const isEmpty = (c: Awaited<ReturnType<typeof counts>>) =>
  c.contactsCount + c.opportunitiesCount + c.appointmentsCount + c.conversationEventsCount === 0;

/** Newest timestamp in a table; soft-deleted rows (visible only to delete-permission holders) are skipped. */
async function newest(scope: DataScope, table: string, column: string, softDelete: boolean): Promise<string | undefined> {
  const query = fromWorkspace(scope, table, column);
  const [row] = await rows<Record<string, string>>(
    (softDelete ? query.is("deleted_at", null) : query).order(column, { ascending: false }).limit(1),
    table
  );
  return row?.[column];
}

/** DashboardSummary from the workspace's native records (same semantics as summaryFromSnapshot). */
export async function nativeSummary(scope: DataScope): Promise<DashboardSummary> {
  const [c, openCents, wonCount, ...latest] = await Promise.all([
    counts(scope),
    openValueCents(scope),
    total(countWorkspace(scope, "opportunities").eq("status", "won").is("deleted_at", null), "opportunities"),
    newest(scope, "activity_events", "created_at", false),
    newest(scope, "contacts", "updated_at", true),
    newest(scope, "opportunities", "updated_at", true),
    newest(scope, "appointments", "updated_at", true),
    newest(scope, "messages", "created_at", false),
  ]);
  return {
    ...c,
    openPipelineValue: centsToAmount(openCents),
    wonCount,
    lastEventAt: latestTimestamp(latest),
    waitingForSync: isEmpty(c),
  };
}

export async function nativeWaitingForSync(scope: DataScope): Promise<boolean> {
  return isEmpty(await counts(scope));
}

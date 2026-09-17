import { EmptyState } from "@/components/ui";

/** Shared empty state when webhook sync has not populated the store yet. */
export function WaitingForSync({
  entity = "data",
}: {
  entity?: string;
}) {
  return (
    <EmptyState
      title="Waiting for HighLevel sync"
      note={`No ${entity} has been received yet. HighLevel workflows should POST normalized events to /api/webhooks/ghl. This dashboard does not read CRM lists directly on the $297 plan.`}
    />
  );
}

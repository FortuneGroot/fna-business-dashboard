import { EmptyState } from "@/components/ui";
import { SYNC_WAITING_TITLE, syncWaitingNote } from "@/lib/ui/sync-copy";

/** Shared empty state when webhook sync has not populated the store yet. */
export function WaitingForSync({
  entity = "data",
}: {
  entity?: string;
}) {
  return <EmptyState title={SYNC_WAITING_TITLE} note={syncWaitingNote(entity)} />;
}

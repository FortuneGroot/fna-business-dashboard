import { EmptyState } from "@/components/ui";
import { dataCopy } from "@/lib/ui/sync-copy";

/** Shared empty state: sync not yet populated (legacy) or no workspace records yet (`native`). */
export function WaitingForSync({
  entity = "data",
  native = false,
}: {
  entity?: string;
  native?: boolean;
}) {
  const copy = dataCopy(native);
  return <EmptyState title={copy.waitingTitle(entity)} note={copy.waitingNote(entity)} />;
}

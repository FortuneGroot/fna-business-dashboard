import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState, Badge } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";
import { SYNC_SOURCE_SHORT, syncBannerWaiting } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const tasks = await getSyncStore().listTaskEvents(50);
  const waiting = tasks.length === 0;

  return (
    <AppShell>
      <PageHead
        title="Tasks"
        description={`Staff next actions from connected task workflows. ${SYNC_SOURCE_SHORT}`}
      />

      <StatusBanner>
        {waiting
          ? syncBannerWaiting("task events")
          : `${tasks.length} task event(s) synced.`}
      </StatusBanner>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Task events" action={<Badge tone="neutral">{tasks.length}</Badge>}>
          {waiting ? (
            <WaitingForSync entity="task events" />
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {tasks.map((t) => (
                <li key={t.id} className="muted">
                  {t.type || "task"} · {t.status || "—"}
                  {t.timestamp ? ` · ${t.timestamp.slice(0, 16).replace("T", " ")}` : ""}
                  {t.assignedUser ? ` · ${t.assignedUser}` : ""}
                </li>
              ))}
            </ul>
          )}
          {!waiting && tasks.length === 0 ? (
            <EmptyState title="No tasks yet" note="No task events have arrived yet." />
          ) : null}
        </Card>
      </div>
    </AppShell>
  );
}

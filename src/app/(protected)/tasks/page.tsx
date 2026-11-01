import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState, Badge } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { NativeTasks } from "@/components/records/NativeTasks";
import { getPageData, getPageScope } from "@/lib/data";
import { listTasks, taskCounts } from "@/lib/native/tasks";
import { dataCopy } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const { reader, native } = await getPageData();
  if (native) {
    const scope = await getPageScope();
    const [initial, counts] = await Promise.all([listTasks(scope, { limit: 50 }), taskCounts(scope)]);
    return <NativeTasks initial={initial} counts={counts} canWrite={scope.ctx.permissions.includes("tasks.write")} />;
  }
  const copy = dataCopy(native);
  const tasks = await reader.listTaskEvents(50);
  const waiting = tasks.length === 0;
  const openTasks = tasks.filter((t) => {
    const s = (t.status || "").toLowerCase();
    return !s || s === "open" || s === "pending" || s === "todo";
  });
  const completedTasks = tasks.filter((t) => /complete|done|closed/i.test(t.status || ""));
  const staleOpen = openTasks.filter((t) => {
    if (!t.timestamp) return false;
    const ageMs = Date.now() - new Date(t.timestamp).getTime();
    return Number.isFinite(ageMs) && ageMs > 7 * 24 * 60 * 60 * 1000;
  });

  return (
    <AppShell>
      <PageHead
        title="Tasks"
        description={`${native ? "Staff next actions in this workspace." : "Staff next actions from connected task workflows."} ${copy.sourceShort}`}
      />

      <StatusBanner>
        {waiting
          ? copy.bannerWaiting("task events")
          : `${tasks.length} ${native ? "task(s)" : "task event(s)"} · ${openTasks.length} open · ${completedTasks.length} completed${
              staleOpen.length
                ? native
                  ? ` · ${staleOpen.length} open and not updated for 7 days`
                  : ` · ${staleOpen.length} open longer than 7 days (due dates are not synced yet)`
                : ""
            }.`}
      </StatusBanner>

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        <Card title="Open">
          <p style={{ margin: 0, fontSize: "1.6rem" }}>{waiting ? "—" : openTasks.length}</p>
        </Card>
        <Card title="Completed">
          <p style={{ margin: 0, fontSize: "1.6rem" }}>{waiting ? "—" : completedTasks.length}</p>
        </Card>
        <Card title="Needs attention">
          <p style={{ margin: 0, fontSize: "1.6rem" }}>{waiting ? "—" : staleOpen.length}</p>
          <p className="muted" style={{ margin: "0.35rem 0 0" }}>
            {native
              ? "Open tasks not updated for 7 days."
              : "Open events older than 7 days. Exact due dates are not in sync yet."}
          </p>
        </Card>
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title={native ? "Tasks" : "Task events"} action={<Badge tone="neutral">{tasks.length}</Badge>}>
          {waiting ? (
            <WaitingForSync entity="task events" native={native} />
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

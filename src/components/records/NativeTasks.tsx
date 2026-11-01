"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Badge, Button, Card, EmptyState, Modal, PageHead } from "@/components/ui";
import { api, failure, fromLocalInput, loadMembers, toLocalInput, when, type Member } from "@/lib/ui/native-api";
import { dataCopy } from "@/lib/ui/sync-copy";
import { ContactPicker, MemberSelect } from "./pickers";

/* Tasks in a native workspace (AUTH_PROVIDER=supabase): the existing page layout with create, edit,
 * assignment, and status changes through /api/tasks. Counts are exact database counts. */

const copy = dataCopy(true);

export type NativeTask = {
  id: string;
  title: string;
  description: string;
  dueAt: string | null;
  status: "open" | "done" | "cancelled";
  contactId: string | null;
  contactName: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  updatedAt: string;
};

export type TaskPage = { items: NativeTask[]; nextCursor: string | null; total: number };
export type TaskCounts = { total: number; open: number; done: number; stale: number };

type Form = { title: string; description: string; due: string; status: NativeTask["status"]; assignee: string; contactId: string; contactName: string | null };

const EMPTY: Form = { title: "", description: "", due: "", status: "open", assignee: "", contactId: "", contactName: null };
const STATUS_LABEL: Record<NativeTask["status"], string> = { open: "open", done: "done", cancelled: "cancelled" };

export function NativeTasks({ initial, counts, canWrite }: { initial: TaskPage; counts: TaskCounts; canWrite: boolean }) {
  const router = useRouter();
  const [page, setPage] = useState(initial);
  const [editing, setEditing] = useState<{ task: NativeTask | null; form: Form } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setPage(initial), [initial]);
  useEffect(() => {
    if (editing && !members.length) void loadMembers().then(setMembers);
  }, [editing, members.length]);

  async function more() {
    if (!page.nextCursor) return;
    setBusy(true);
    const { body } = await api(`/api/tasks?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`);
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not load more tasks."));
      return;
    }
    const next = body as unknown as TaskPage;
    setPage((p) => ({ ...next, items: [...p.items, ...next.items] }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const { task, form } = editing;
    const dueAt = form.due ? fromLocalInput(form.due) : null;
    if (form.due && !dueAt) {
      setError("Choose a valid due date.");
      return;
    }
    const body = {
      title: form.title,
      description: form.description,
      dueAt,
      status: form.status,
      assignedUserId: form.assignee || null,
      contactId: form.contactId || null,
    };
    setBusy(true);
    const res = await api(task ? `/api/tasks/${task.id}` : "/api/tasks", { method: task ? "PATCH" : "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!res.body.ok) {
      setError(failure(res.body, "Could not save the task."));
      return;
    }
    setError("");
    setEditing(null);
    router.refresh();
  }

  async function setStatus(task: NativeTask, status: NativeTask["status"]) {
    const res = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (!res.body.ok) {
      setError(failure(res.body, "Could not update the task."));
      return;
    }
    setError("");
    router.refresh();
  }

  const empty = counts.total === 0;
  const set = (patch: Partial<Form>) => setEditing((s) => (s ? { ...s, form: { ...s.form, ...patch } } : s));

  return (
    <AppShell>
      <PageHead
        title="Tasks"
        description={`Staff next actions in this workspace. ${copy.sourceShort}`}
        action={canWrite ? <Button size="sm" variant="secondary" onClick={() => setEditing({ task: null, form: EMPTY })}>Add task</Button> : undefined}
      />

      <StatusBanner>
        {empty
          ? copy.bannerWaiting("task events")
          : `${counts.total} task(s) · ${counts.open} open · ${counts.done} completed${
              counts.stale ? ` · ${counts.stale} open and not updated for 7 days` : ""
            }.`}
      </StatusBanner>
      {error ? <div className="banner error" role="alert">{error}</div> : null}

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        <Card title="Open">
          <p style={{ margin: 0, fontSize: "1.6rem" }}>{empty ? "—" : counts.open}</p>
        </Card>
        <Card title="Completed">
          <p style={{ margin: 0, fontSize: "1.6rem" }}>{empty ? "—" : counts.done}</p>
        </Card>
        <Card title="Needs attention">
          <p style={{ margin: 0, fontSize: "1.6rem" }}>{empty ? "—" : counts.stale}</p>
          <p className="muted" style={{ margin: "0.35rem 0 0" }}>Open tasks not updated for 7 days.</p>
        </Card>
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Tasks" action={<Badge tone="neutral">{counts.total}</Badge>}>
          {page.items.length === 0 ? (
            <EmptyState title={copy.waitingTitle("task events")} note={copy.waitingNote("task events")} />
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {page.items.map((t) => (
                <li key={t.id} className="muted">
                  {t.title} · {STATUS_LABEL[t.status]}
                  {t.dueAt ? ` · due ${when(t.dueAt)}` : ` · ${when(t.updatedAt)}`}
                  {t.assignedName ? ` · ${t.assignedName}` : ""}
                  {t.contactName ? ` · ${t.contactName}` : ""}
                  {canWrite ? (
                    <>
                      {" "}
                      {t.status === "open" ? (
                        <button type="button" className="btn ghost sm" onClick={() => void setStatus(t, "done")} aria-label={`Mark ${t.title} done`}>
                          Mark done
                        </button>
                      ) : (
                        <button type="button" className="btn ghost sm" onClick={() => void setStatus(t, "open")} aria-label={`Reopen ${t.title}`}>
                          Reopen
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Edit ${t.title}`}
                        onClick={() =>
                          setEditing({
                            task: t,
                            form: {
                              title: t.title,
                              description: t.description,
                              due: toLocalInput(t.dueAt),
                              status: t.status,
                              assignee: t.assignedUserId ?? "",
                              contactId: t.contactId ?? "",
                              contactName: t.contactName,
                            },
                          })
                        }
                      >
                        Edit
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {page.items.length ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              Showing {page.items.length} of {page.total}.{" "}
              {page.nextCursor ? (
                <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void more()}>
                  Load more
                </button>
              ) : null}
            </p>
          ) : null}
        </Card>
      </div>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.task ? "Edit task" : "Add task"}>
        {editing ? (
          <form onSubmit={save} aria-label="Task">
            {error ? <div className="banner error" role="alert">{error}</div> : null}
            <label htmlFor="task-title">Title</label>
            <input id="task-title" value={editing.form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} required />
            <label htmlFor="task-description">Details</label>
            <textarea id="task-description" rows={3} maxLength={10000} value={editing.form.description} onChange={(e) => set({ description: e.target.value })} />
            <div className="grid grid-2">
              <div>
                <label htmlFor="task-due">Due (your local time)</label>
                <input id="task-due" type="datetime-local" value={editing.form.due} onChange={(e) => set({ due: e.target.value })} />
              </div>
              <div>
                <label htmlFor="task-status">Status</label>
                <select id="task-status" value={editing.form.status} onChange={(e) => set({ status: e.target.value as NativeTask["status"] })}>
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>
            <MemberSelect id="task-assignee" label="Assigned to" value={editing.form.assignee} members={members} onChange={(assignee) => set({ assignee })} />
            <ContactPicker id="task-contact" optional value={editing.form.contactId} initialName={editing.form.contactName} onChange={(contactId) => set({ contactId })} />
            <div style={{ marginTop: "0.8rem" }}>
              <Button type="submit" disabled={busy}>{editing.task ? "Save task" : "Add task"}</Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </AppShell>
  );
}

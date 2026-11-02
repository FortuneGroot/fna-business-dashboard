"use client";

import { FormEvent, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Button, Card, DataTable, EmptyState, Modal, PageHead } from "@/components/ui";
import { api, failure, when } from "@/lib/ui/native-api";
import { dataCopy } from "@/lib/ui/sync-copy";

/* Conversations in a native workspace (AUTH_PROVIDER=supabase): reads through /api/conversations and
 * internal notes only. Nothing here sends a message; the database accepts only internal, not-sent rows. */

const copy = dataCopy(true);
const FILTERS = [
  { label: "All", status: "" },
  { label: "Open", status: "open" },
  { label: "Closed", status: "closed" },
] as const;

export type NativeConversation = {
  id: string;
  contactName: string | null;
  channel: string;
  status: "open" | "closed";
  assignedName: string | null;
  lastMessageAt: string | null;
  createdAt: string;
};
export type ConversationPage = { items: NativeConversation[]; nextCursor: string | null; total: number };

type Message = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  body: string;
  authorName: string | null;
  deliveryStatus: string;
  createdAt: string;
};

const DIRECTION: Record<Message["direction"], string> = { inbound: "Received", outbound: "Sent", internal: "Internal note" };

export function NativeInbox({ initial, canWrite }: { initial: ConversationPage; canWrite: boolean }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["status"]>("");
  const [page, setPage] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ convo: NativeConversation; messages: Message[]; nextCursor: string | null } | null>(null);
  const [note, setNote] = useState("");
  const latest = useRef(0);
  const latestThread = useRef(0);
  const [threadLoading, setThreadLoading] = useState(false);

  async function load(status: string, cursor?: string | null) {
    const params = new URLSearchParams({ limit: "50" });
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    const request = ++latest.current;
    setBusy(true);
    const { body } = await api(`/api/conversations?${params}`);
    if (request !== latest.current) return;
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not load conversations."));
      return;
    }
    setError("");
    const next = body as unknown as ConversationPage;
    setPage((p) => (cursor ? { ...next, items: [...p.items, ...next.items] } : next));
  }

  async function open(convo: NativeConversation, cursor?: string | null) {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const request = ++latestThread.current;
    setThreadLoading(true);
    const { body } = await api(`/api/conversations/${convo.id}/messages?${params}`);
    if (request !== latestThread.current) return;
    setThreadLoading(false);
    if (!body.ok) {
      setError(failure(body, "Could not open this conversation."));
      return;
    }
    const items = body.items as Message[];
    setError("");
    setThread((t) => ({
      convo,
      messages: cursor && t ? [...t.messages, ...items] : items,
      nextCursor: (body.nextCursor as string | null) ?? null,
    }));
  }

  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!thread) return;
    setBusy(true);
    const { body } = await api(`/api/conversations/${thread.convo.id}/notes`, { method: "POST", body: JSON.stringify({ body: note }) });
    setBusy(false);
    if (!body.ok) {
      setError(failure(body, "Could not save the note."));
      return;
    }
    setNote("");
    setError("");
    await open(thread.convo);
  }

  const rows = page.items.map((c) => [
    <button key={c.id} type="button" className="btn ghost sm" onClick={() => void open(c)} aria-label={`Open conversation with ${c.contactName ?? "contact"}`}>
      {c.contactName ?? "Contact"}
    </button>,
    c.channel,
    c.status === "open" ? "Open" : "Closed",
    when(c.lastMessageAt ?? c.createdAt),
  ]);
  const empty = page.total === 0 && !filter;

  return (
    <AppShell>
      <PageHead title="Conversations" description={`${copy.sourceShort} Open a thread to read messages and add internal notes.`} />

      <StatusBanner>
        {empty
          ? copy.bannerWaiting("conversation events")
          : "Showing this workspace's messages. Do not send from this view until messaging channels are live."}
      </StatusBanner>
      {error && !thread ? <div className="banner error" role="alert">{error}</div> : null}

      <div className="quick-actions" style={{ margin: "1.1rem 0" }} role="tablist" aria-label="Conversation filters">
        {FILTERS.map((f) => (
          <Button
            key={f.label}
            size="sm"
            variant={filter === f.status ? "primary" : "secondary"}
            aria-pressed={filter === f.status}
            onClick={() => {
              setFilter(f.status);
              void load(f.status);
            }}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <Card title="Conversation Threads">
        {empty ? (
          <EmptyState title={copy.waitingTitle("conversations")} note={copy.waitingNote("conversations")} />
        ) : (
          <DataTable
            columns={["Contact", "Channel", "Status", "Last Activity"]}
            rows={rows}
            emptyTitle="No conversations match this filter"
            emptyNote="Conversations in this workspace appear here."
          />
        )}
        {page.items.length ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Showing {page.items.length} of {page.total}.{" "}
            {page.nextCursor ? (
              <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void load(filter, page.nextCursor)}>
                Load more
              </button>
            ) : null}
          </p>
        ) : null}
      </Card>

      <Modal open={Boolean(thread)} onClose={() => setThread(null)} title={thread ? `Conversation with ${thread.convo.contactName ?? "contact"}` : "Conversation"}>
        {thread ? (
          <div>
            {error ? <div className="banner error" role="alert">{error}</div> : null}
            <p className="muted" style={{ marginTop: 0 }}>
              {thread.convo.channel} · {thread.convo.status} · {thread.convo.assignedName ?? "Unassigned"}
            </p>
            {thread.messages.length === 0 ? (
              <EmptyState title="No messages yet" />
            ) : (
              <ul style={{ paddingLeft: "1.1rem" }} aria-label="Messages, newest first">
                {thread.messages.map((m) => (
                  <li key={m.id}>
                    <strong>{DIRECTION[m.direction]}</strong>
                    {m.authorName ? ` · ${m.authorName}` : ""} · <span className="muted">{when(m.createdAt)}</span>
                    <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
                  </li>
                ))}
              </ul>
            )}
            {thread.nextCursor ? (
              <Button size="sm" variant="secondary" disabled={threadLoading} onClick={() => void open(thread.convo, thread.nextCursor)}>
                Older messages
              </Button>
            ) : null}
            {canWrite ? (
              <form onSubmit={addNote} aria-label="Add an internal note" style={{ marginTop: "0.8rem" }}>
                <label htmlFor="convo-note">Internal note (visible to your team only; never sent)</label>
                <textarea id="convo-note" rows={3} maxLength={20000} value={note} onChange={(e) => setNote(e.target.value)} required />
                <div style={{ marginTop: "0.5rem" }}>
                  <Button type="submit" size="sm" disabled={busy}>Save internal note</Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </AppShell>
  );
}

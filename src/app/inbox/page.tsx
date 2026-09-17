"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";

const FILTERS = ["All", "Unread", "Awaiting Reply"] as const;

type ConvoRow = {
  id: string;
  contactId: string;
  direction: string;
  channel: string;
  eventType: string;
  timestamp: string;
  summary: string;
};

export default function InboxPage() {
  const [active, setActive] = useState<(typeof FILTERS)[number]>("All");
  const [rows, setRows] = useState<ConvoRow[]>([]);
  const [waiting, setWaiting] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/conversations");
        const data = await res.json();
        if (cancelled) return;
        const list = Array.isArray(data.conversations) ? data.conversations : [];
        setRows(list);
        setWaiting(Boolean(data.waitingForSync) || list.length === 0);
      } catch {
        if (!cancelled) {
          setRows([]);
          setWaiting(true);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered =
    active === "All"
      ? rows
      : active === "Unread"
        ? rows.filter((r) => r.direction === "inbound")
        : rows.filter((r) => r.direction === "inbound");

  const tableRows = filtered.map((r) => [
    r.contactId || "—",
    r.channel || "—",
    r.summary || r.eventType || "—",
    r.timestamp ? r.timestamp.slice(0, 16).replace("T", " ") : "—",
  ]);

  return (
    <AppShell>
      <PageHead
        title="Conversations"
        description="Conversation events synced from HighLevel (summary only — full message history is not replicated on the $297 plan)."
      />

      <StatusBanner>
        {!loaded
          ? "Loading sync state…"
          : waiting
            ? "Waiting for HighLevel sync — no conversation events yet."
            : "Showing synced conversation events. Do not send from this view until messaging channels are live."}
      </StatusBanner>

      <div className="quick-actions" style={{ margin: "1.1rem 0" }} role="tablist" aria-label="Conversation filters">
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={active === f ? "primary" : "secondary"}
            onClick={() => setActive(f)}
          >
            {f}
          </Button>
        ))}
      </div>

      <Card title="Conversation Threads">
        {waiting ? (
          <WaitingForSync entity="conversations" />
        ) : (
          <DataTable
            columns={["Contact", "Channel", "Last Message", "Last Activity"]}
            rows={tableRows}
            emptyTitle="No conversations awaiting reply yet"
            emptyNote="Threads will appear here once conversation sync events arrive."
          />
        )}
      </Card>
    </AppShell>
  );
}

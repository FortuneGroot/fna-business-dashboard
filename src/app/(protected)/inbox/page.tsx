"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button, LoadError } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SYNC_SOURCE_SHORT, syncBannerWaiting } from "@/lib/ui/sync-copy";

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

type LoadState = "loading" | "ready" | "unauthorized" | "error";

export default function InboxPage() {
  const [active, setActive] = useState<(typeof FILTERS)[number]>("All");
  const [rows, setRows] = useState<ConvoRow[]>([]);
  const [waiting, setWaiting] = useState(true);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    setErrorMessage("");
    try {
      const res = await fetch("/api/dashboard/conversations");
      if (res.status === 401 || res.status === 403) {
        setRows([]);
        setWaiting(true);
        setState("unauthorized");
        setErrorMessage("Your session expired or you are not signed in. Sign out and sign back in.");
        return;
      }
      if (!res.ok) {
        setState("error");
        setErrorMessage("The conversations API returned an unexpected response.");
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data.conversations) ? data.conversations : [];
      setRows(list);
      setWaiting(Boolean(data.waitingForSync) || list.length === 0);
      setState("ready");
    } catch {
      setRows([]);
      setWaiting(true);
      setState("error");
      setErrorMessage("Network error while loading conversations.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered =
    active === "All"
      ? rows
      : active === "Unread"
        ? rows.filter(
            (r) =>
              r.direction === "inbound" ||
              /inbound|reply/i.test(r.eventType || "")
          )
        : rows.filter((r) => {
            // Awaiting reply: inbound that asks for human help / handoff.
            const et = `${r.eventType || ""} ${r.summary || ""}`;
            return (
              (r.direction === "inbound" || /inbound|reply/i.test(r.eventType || "")) &&
              /handoff|human|escalat|await/i.test(et)
            );
          });

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
        description={`${SYNC_SOURCE_SHORT} Full message history is not replicated in this plan.`}
      />

      {state === "unauthorized" || state === "error" ? (
        <LoadError message={errorMessage} onRetry={load} />
      ) : (
        <StatusBanner>
          {state === "loading"
            ? "Loading sync state…"
            : waiting
              ? syncBannerWaiting("conversation events")
              : "Showing synced conversation events. Do not send from this view until messaging channels are live."}
        </StatusBanner>
      )}

      <div className="quick-actions" style={{ margin: "1.1rem 0" }} role="tablist" aria-label="Conversation filters">
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={active === f ? "primary" : "secondary"}
            aria-pressed={active === f}
            onClick={() => setActive(f)}
          >
            {f}
          </Button>
        ))}
      </div>

      <Card title="Conversation Threads">
        {state === "loading" ? (
          <EmptyLoading />
        ) : waiting || state !== "ready" ? (
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

function EmptyLoading() {
  return (
    <div className="empty" role="status" aria-live="polite">
      <strong>Loading conversations…</strong>
      <span>Fetching the latest synced events.</span>
    </div>
  );
}

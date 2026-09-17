"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button } from "@/components/ui";

const FILTERS = ["All", "Unread", "Awaiting Reply"] as const;

export default function InboxPage() {
  const [active, setActive] = useState<(typeof FILTERS)[number]>("All");

  return (
    <AppShell>
      <PageHead
        title="Conversations"
        description="Texts, email, chat, and social replies in one place once those channels are connected for this account."
      />

      <StatusBanner>
        This is a shell only — no messaging channel is connected yet. Do not send from this view
        until SMS/email are live.
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
        <DataTable
          columns={["Contact", "Channel", "Last Message", "Last Activity"]}
          rows={[]}
          emptyTitle="No conversations awaiting reply yet"
          emptyNote="Threads from SMS, email, chat, and social will appear here once messaging channels are connected."
        />
      </Card>
    </AppShell>
  );
}

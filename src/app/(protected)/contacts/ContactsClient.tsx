"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { dataCopy } from "@/lib/ui/sync-copy";

export type ContactRow = {
  id: string;
  name: string;
  hasPhone: boolean;
  hasEmail: boolean;
  source: string;
  updatedAt: string;
};

export function ContactsClient({
  contacts,
  waiting,
  native = false,
}: {
  contacts: ContactRow[];
  waiting: boolean;
  native?: boolean;
}) {
  const copy = dataCopy(native);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      if (c.source && c.source !== "—") set.add(c.source);
    }
    return Array.from(set).sort();
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (source && c.source !== source) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.source.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    });
  }, [contacts, query, source]);

  const rows = filtered.map((c) => [
    c.name,
    c.hasPhone ? "•••" : "—",
    c.hasEmail ? "•••" : "—",
    c.source || "—",
    c.updatedAt || "—",
  ]);

  return (
    <AppShell>
      <PageHead title="Contacts" description={copy.sourceShort} />

      <StatusBanner>
        {waiting
          ? copy.bannerWaiting("contacts")
          : `${contacts.length} contact(s) ${native ? "in this workspace" : "from workflow sync"}. Phone/email masked in this view.`}
      </StatusBanner>

      <div className="grid grid-2" style={{ margin: "0 0 1.1rem" }}>
        <div>
          <label htmlFor="contact-search">{native ? "Search contacts" : "Search synced contacts"}</label>
          <input
            id="contact-search"
            type="search"
            placeholder="Name or source"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={waiting}
            aria-disabled={waiting}
          />
        </div>
        <div>
          <label htmlFor="contact-source">Source</label>
          <select
            id="contact-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={waiting || sources.length === 0}
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {native
          ? "Search and source filters apply to this workspace's contacts."
          : "Search and source filters apply only to contacts already synced into this dashboard."}
        {" "}Adding contacts is not available yet.
      </p>

      <Card
        title="All Contacts"
        action={
          <Button size="sm" variant="secondary" disabled>
            Add a contact (coming soon)
          </Button>
        }
      >
        {waiting ? (
          <WaitingForSync entity="contacts" native={native} />
        ) : (
          <DataTable
            columns={["Name", "Phone", "Email", "Source", "Last Activity"]}
            rows={rows}
            emptyTitle={query || source ? "No matching contacts" : "No contacts yet"}
            emptyNote={
              query || source
                ? "Try a different search or clear the source filter."
                : native
                  ? "Contacts added to this workspace appear here."
                  : "Contacts will appear here once sync events arrive."
            }
          />
        )}
      </Card>
    </AppShell>
  );
}

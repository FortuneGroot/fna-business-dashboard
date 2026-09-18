import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";
import { SYNC_SOURCE_SHORT, syncBannerWaiting } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const contacts = await getSyncStore().listContacts();
  const waiting = contacts.length === 0;

  const rows = contacts.map((c) => [
    c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.externalContactId,
    c.phone ? "•••" : "—",
    c.email ? "•••" : "—",
    c.source || "—",
    c.updatedAt ? c.updatedAt.slice(0, 16).replace("T", " ") : "—",
  ]);

  return (
    <AppShell>
      <PageHead title="Contacts" description={SYNC_SOURCE_SHORT} />

      <StatusBanner>
        {waiting
          ? syncBannerWaiting("contacts")
          : `${contacts.length} contact(s) from workflow sync. Phone/email masked in this view.`}
      </StatusBanner>

      <div className="grid grid-2" style={{ margin: "1.1rem 0" }}>
        <div>
          <label htmlFor="contact-search">Search</label>
          <input
            id="contact-search"
            type="search"
            placeholder="Search by name, email, or phone"
            disabled
            aria-disabled="true"
          />
        </div>
        <div>
          <label htmlFor="contact-source">Source</label>
          <select id="contact-source" disabled defaultValue="" aria-disabled="true">
            <option value="">All sources</option>
          </select>
        </div>
      </div>

      <Card
        title="All Contacts"
        action={
          <Button size="sm" variant="secondary" disabled>
            Add a contact
          </Button>
        }
      >
        {waiting ? (
          <WaitingForSync entity="contacts" />
        ) : (
          <DataTable
            columns={["Name", "Phone", "Email", "Source", "Last Activity"]}
            rows={rows}
            emptyTitle="No contacts yet"
            emptyNote="Contacts will appear here once sync events arrive."
          />
        )}
      </Card>
    </AppShell>
  );
}

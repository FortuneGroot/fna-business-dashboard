import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export default function ContactsPage() {
  const contacts = getSyncStore().listContacts();
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
      <PageHead
        title="Contacts"
        description="People synced from HighLevel workflow webhooks. Search UI remains ready; data is not pulled via CRM list APIs."
      />

      <StatusBanner>
        {waiting
          ? "Waiting for HighLevel sync — no contacts received yet."
          : `${contacts.length} contact(s) from webhook sync. Phone/email masked in this view.`}
      </StatusBanner>

      <div className="grid grid-2" style={{ margin: "1.1rem 0" }}>
        <div>
          <label htmlFor="contact-search">Search</label>
          <input
            id="contact-search"
            type="text"
            placeholder="Search by name, email, or phone"
            disabled
          />
        </div>
        <div>
          <label htmlFor="contact-source">Source</label>
          <select id="contact-source" disabled defaultValue="">
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
            emptyNote="Contacts will appear here once HighLevel sync events arrive."
          />
        )}
      </Card>
    </AppShell>
  );
}

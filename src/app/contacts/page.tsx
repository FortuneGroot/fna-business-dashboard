import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, DataTable, Button } from "@/components/ui";

export default function ContactsPage() {
  return (
    <AppShell>
      <PageHead
        title="Contacts"
        description="People who asked for help. Search by name, email, or phone once this account is connected."
      />

      <StatusBanner>
        This is a shell only — no contacts are loaded. Do not invent or import real people into
        this preview.
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
          <Button size="sm" variant="secondary">
            Add a contact
          </Button>
        }
      >
        <DataTable
          columns={["Name", "Phone", "Email", "Source", "Last Activity"]}
          rows={[]}
          emptyTitle="No contacts yet"
          emptyNote="Contacts will appear here once this account is connected."
        />
      </Card>
    </AppShell>
  );
}

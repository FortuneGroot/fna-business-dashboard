import { AppShell } from "@/components/AppShell";
import { Card, MetricTile, EmptyState, PageHead } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SidebarIcon } from "@/components/Sidebar";
import { getSyncStore } from "@/lib/sync";
import Link from "next/link";
import { SYNC_SOURCE_SHORT } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function ReportingPage() {
  const summary = await getSyncStore().summary();
  const waiting = summary.waitingForSync;

  const metrics = [
    {
      label: "Leads Synced",
      value: waiting ? "—" : String(summary.contactsCount),
      note: "Contacts received from connected workflow sync.",
      icon: "contacts" as const,
      href: "/contacts",
    },
    {
      label: "Won Count",
      value: waiting ? "—" : String(summary.wonCount),
      note: "From won-opportunity sync events.",
      icon: "reports" as const,
      href: "/pipeline",
    },
    {
      label: "Open Pipeline Value",
      value: waiting ? "—" : `$${summary.openPipelineValue.toLocaleString()}`,
      note: "Sum of open synced opportunities.",
      icon: "opportunities" as const,
      href: "/pipeline",
    },
    {
      label: "Appointments Synced",
      value: waiting ? "—" : String(summary.appointmentsCount),
      note: "From appointment sync events.",
      icon: "calendar" as const,
      href: "/calendar",
    },
  ];

  return (
    <AppShell>
      <PageHead title="Reports" description={SYNC_SOURCE_SHORT} />

      <div className="grid grid-4">
        {metrics.map((m) => (
          <MetricTile
            key={m.label}
            label={m.label}
            value={m.value}
            note={m.note}
            href={m.href}
            icon={<SidebarIcon name={m.icon} />}
          />
        ))}
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Trend">
          {waiting ? (
            <WaitingForSync entity="report data" />
          ) : (
            <EmptyState
              title="Totals only for now"
              note="Detailed trend charts are not available yet. Current totals reflect synced activity."
            />
          )}
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </AppShell>
  );
}

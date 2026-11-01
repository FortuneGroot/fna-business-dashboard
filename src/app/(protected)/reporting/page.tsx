import { AppShell } from "@/components/AppShell";
import { Card, MetricTile, EmptyState, PageHead } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SidebarIcon } from "@/components/Sidebar";
import { getPageData } from "@/lib/data";
import Link from "next/link";
import { dataCopy } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function ReportingPage() {
  const { reader, native } = await getPageData();
  const copy = dataCopy(native);
  const summary = await reader.summary();
  const waiting = summary.waitingForSync;

  const metrics = [
    {
      label: native ? "Contacts" : "Leads Synced",
      value: waiting ? "—" : String(summary.contactsCount),
      note: native ? "Contacts in this workspace." : "Contacts received from connected workflow sync.",
      icon: "contacts" as const,
      href: "/contacts",
    },
    {
      label: "Won Count",
      value: waiting ? "—" : String(summary.wonCount),
      note: native ? "Opportunities marked won." : "From won-opportunity sync events.",
      icon: "reports" as const,
      href: "/pipeline",
    },
    {
      label: "Open Pipeline Value",
      value: waiting ? "—" : `$${summary.openPipelineValue.toLocaleString()}`,
      note: native ? "Sum of open opportunities." : "Sum of open synced opportunities.",
      icon: "opportunities" as const,
      href: "/pipeline",
    },
    {
      label: native ? "Appointments" : "Appointments Synced",
      value: waiting ? "—" : String(summary.appointmentsCount),
      note: native ? "Appointments on this workspace's calendars." : "From appointment sync events.",
      icon: "calendar" as const,
      href: "/calendar",
    },
  ];

  return (
    <AppShell>
      <PageHead title="Reports" description={copy.sourceShort} />

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
            <WaitingForSync entity="report data" native={native} />
          ) : (
            <EmptyState
              title="Totals only for now"
              note={`${native ? "Last activity" : "Last successful sync event"}: ${
                summary.lastEventAt
                  ? summary.lastEventAt.slice(0, 19).replace("T", " ")
                  : "none yet"
              }. Detailed trend charts are not available yet.`}
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

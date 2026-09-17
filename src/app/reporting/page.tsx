import { AppShell } from "@/components/AppShell";
import { Card, MetricTile, EmptyState, PageHead } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SidebarIcon } from "@/components/Sidebar";
import { BRAND } from "@/lib/brand";
import { getSyncStore } from "@/lib/sync";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ReportingPage() {
  const summary = getSyncStore().summary();
  const waiting = summary.waitingForSync;

  const metrics = [
    {
      label: "Leads Synced",
      value: waiting ? "—" : String(summary.contactsCount),
      note: "Contacts received via webhook sync — never fabricated.",
      icon: "contacts" as const,
    },
    {
      label: "Won Count",
      value: waiting ? "—" : String(summary.wonCount),
      note: "From opportunity.won sync events.",
      icon: "reports" as const,
    },
    {
      label: "Open Pipeline Value",
      value: waiting ? "—" : `$${summary.openPipelineValue.toLocaleString()}`,
      note: "Sum of open synced opportunities.",
      icon: "opportunities" as const,
    },
    {
      label: "Appointments Synced",
      value: waiting ? "—" : String(summary.appointmentsCount),
      note: "From appointment.* webhook events.",
      icon: "calendar" as const,
    },
  ];

  return (
    <AppShell>
      <PageHead
        title="Reports"
        description="Figures come from the normalized HighLevel webhook sync store. Nothing is fabricated — values stay at — until sync events arrive."
      />

      <div className="grid grid-4">
        {metrics.map((m) => (
          <MetricTile
            key={m.label}
            label={m.label}
            value={m.value}
            note={m.note}
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
              title="Sync-backed reporting"
              note="Detailed trend charts can be added once durable production persistence is connected. Current totals reflect the in-process sync store."
            />
          )}
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        Full breakdown view (when enabled): {BRAND.dashboards.sales}.{" "}
        <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </AppShell>
  );
}

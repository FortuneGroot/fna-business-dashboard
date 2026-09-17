import { AppShell } from "@/components/AppShell";
import { Card, MetricTile, EmptyState, PageHead } from "@/components/ui";
import { SidebarIcon } from "@/components/Sidebar";
import { BRAND } from "@/lib/brand";
import Link from "next/link";

const METRICS = [
  {
    label: "Leads This Month",
    value: "—",
    note: "Native Contacts count for the current month. Not connected yet — never fabricated.",
    icon: "contacts" as const,
  },
  {
    label: "Conversion Rate",
    value: "—",
    note: "Not native, stays empty — never fabricate a tile.",
    icon: "reports" as const,
  },
  {
    label: "Won Revenue",
    value: "—",
    note: "Native Won-opportunity value this month. Lives on the Sales Performance view once enabled.",
    icon: "payments" as const,
  },
  {
    label: "Pipeline Value",
    value: "—",
    note: "Native open-opportunity value on Fortune & Automations Sales Pipeline. No fabricated dollars.",
    icon: "opportunities" as const,
  },
];

export default function ReportingPage() {
  return (
    <AppShell>
      <PageHead
        title="Reports"
        description="Owner Command Center and Sales & Lead Performance use native widgets only. Nothing on this page is fabricated — figures stay at — until the CRM connection is live."
      />

      <div className="grid grid-4">
        {METRICS.map((m) => (
          <MetricTile key={m.label} label={m.label} value={m.value} note={m.note} icon={<SidebarIcon name={m.icon} />} />
        ))}
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Trend">
          <EmptyState
            title="No report data yet"
            note="A revenue and lead trend chart will render here once native reporting is connected. Custom report embeds are not available in this shell."
          />
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        Full breakdown view (when enabled): {BRAND.dashboards.sales}. <Link href="/dashboard">Back to dashboard</Link>
      </p>
    </AppShell>
  );
}

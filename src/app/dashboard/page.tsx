import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, MetricTile, Badge, EmptyState, QuickActions, Button } from "@/components/ui";
import { SidebarIcon } from "@/components/Sidebar";
import Link from "next/link";

const METRICS = [
  { label: "New Leads", value: "—", note: "Native Contacts count is an approximation, not a true lead qualifier.", icon: "contacts" as const },
  { label: "Pipeline Value", value: "—", note: "Native open-opportunity value on Fortune & Automations Sales Pipeline. No fabricated dollars.", icon: "opportunities" as const },
  { label: "Appointments", value: "—", note: "Native upcoming-appointment count. A submitted form time is not a confirmed booking.", icon: "calendar" as const },
  { label: "Conversations Awaiting Reply", value: "—", note: "Not a dashboard tile natively — pulled from Inbox once connected.", icon: "conversations" as const },
  { label: "Won Revenue", value: "—", note: "Native Won-opportunity value this month. Lives on the Sales Performance view once enabled.", icon: "payments" as const },
  { label: "Won Opportunities", value: "—", note: "Native Won count, current pipeline only.", icon: "reports" as const },
  { label: "Lead Sources", value: "—", note: "Not natively available as a dashboard tile — stays empty rather than fabricated.", icon: "marketing" as const },
  { label: "Follow-Up Required", value: "—", note: "Human Follow-Up Required flag, once workflows are live.", icon: "automations" as const },
];

export default function DashboardPage() {
  return (
    <AppShell>
      <section className="hero">
        <Badge tone="gold">Owner Command Center</Badge>
        <h1 style={{ marginTop: "0.6rem" }}>Fortune & Automations Business Dashboard</h1>
        <p>
          AUTOMATION · WEBSITES · BRANDING · SYSTEMS. Make your business look better, work smarter, and run
          smoother. This is the client product shell — customer lists, messages, and calendars appear here
          once the account is connected. Nothing on this page is live data.
        </p>
      </section>

      <StatusBanner>
        Morning routine: Needs Attention → claim an unassigned new lead → check Conversations → review
        today&apos;s calendar. None of these lists are connected yet in this shell.
      </StatusBanner>

      <div className="grid grid-4" style={{ marginTop: "1.1rem" }}>
        {METRICS.map((m) => (
          <MetricTile key={m.label} label={m.label} value={m.value} note={m.note} icon={<SidebarIcon name={m.icon} />} />
        ))}
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Needs Attention">
          <EmptyState
            title="No leads yet"
            note="Unassigned new leads and overdue follow-ups will surface here once the CRM is connected."
          />
        </Card>
        <Card title="Reviews">
          <EmptyState
            title="No reviews yet"
            note="Reputation is native but blocked on Google Business Profile connection."
            action={
              <Link href="/reviews" className="btn secondary sm">
                Open Reputation
              </Link>
            }
          />
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Recent Activity">
          <EmptyState title="No activity yet" note="Contact updates, bookings, and stage moves will appear here." />
        </Card>
        <Card title="Quick Actions">
          <QuickActions>
            <Button variant="secondary" href="/contacts">Add a contact</Button>
            <Button variant="secondary" href="/pipeline">View pipeline</Button>
            <Button variant="secondary" href="/calendar">Open calendar</Button>
            <Button variant="secondary" href="/marketing">Marketing</Button>
          </QuickActions>
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        Sales-performance view (when enabled): F&amp;A | SALES &amp; LEAD PERFORMANCE. <Link href="/reporting">Reporting</Link> ·{" "}
        <Link href="/training">Training</Link>
      </p>
    </AppShell>
  );
}

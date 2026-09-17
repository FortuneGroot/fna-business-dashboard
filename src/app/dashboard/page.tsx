import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, MetricTile, Badge, EmptyState, QuickActions, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SidebarIcon } from "@/components/Sidebar";
import { getSyncStore } from "@/lib/sync";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const summary = getSyncStore().summary();
  const events = getSyncStore().listAuditEvents(8);
  const waiting = summary.waitingForSync;

  const metrics = [
    {
      label: "New Leads",
      value: waiting ? "—" : String(summary.contactsCount),
      note: "Contacts synced from HighLevel workflow webhooks.",
      icon: "contacts" as const,
    },
    {
      label: "Pipeline Value",
      value: waiting ? "—" : `$${summary.openPipelineValue.toLocaleString()}`,
      note: "Open opportunity value from synced opportunities.",
      icon: "opportunities" as const,
    },
    {
      label: "Appointments",
      value: waiting ? "—" : String(summary.appointmentsCount),
      note: "Appointments synced from booking workflows.",
      icon: "calendar" as const,
    },
    {
      label: "Conversation Events",
      value: waiting ? "—" : String(summary.conversationEventsCount),
      note: "Inbound/outbound/handoff events (summary only).",
      icon: "conversations" as const,
    },
    {
      label: "Won Opportunities",
      value: waiting ? "—" : String(summary.wonCount),
      note: "Won events from opportunity.won sync.",
      icon: "reports" as const,
    },
    {
      label: "Last Sync Event",
      value: waiting ? "—" : summary.lastEventAt ? summary.lastEventAt.slice(0, 16).replace("T", " ") : "—",
      note: "Timestamp of the most recent ingested webhook.",
      icon: "automations" as const,
    },
  ];

  return (
    <AppShell>
      <section className="hero">
        <Badge tone="gold">Owner Command Center</Badge>
        <h1 style={{ marginTop: "0.6rem" }}>Fortune & Automations Business Dashboard</h1>
        <p>
          AUTOMATION · WEBSITES · BRANDING · SYSTEMS. Make your business look better, work smarter, and run
          smoother. Data on this page comes from HighLevel workflow webhooks — not live CRM list APIs.
        </p>
      </section>

      <StatusBanner>
        {waiting
          ? "Waiting for HighLevel sync. Workflows must POST events to /api/webhooks/ghl before metrics populate."
          : "Synced from HighLevel webhooks. HighLevel remains the CRM source of truth."}
      </StatusBanner>

      <div className="grid grid-4" style={{ marginTop: "1.1rem" }}>
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

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Needs Attention">
          {waiting ? (
            <WaitingForSync entity="leads" />
          ) : (
            <EmptyState
              title={`${summary.contactsCount} contact(s) synced`}
              note="Use Contacts and Pipeline views for detail. Unassigned follow-ups will surface here as workflows send richer events."
            />
          )}
        </Card>
        <Card title="Reviews">
          <EmptyState
            title="Review events via sync"
            note="review.requested / review.feedback_received populate when WF 60.xx webhooks fire."
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
          {waiting || events.length === 0 ? (
            <WaitingForSync entity="activity" />
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {events.map((e) => (
                <li key={e.id} className="muted">
                  {e.eventType} · {e.receivedAt.slice(0, 19).replace("T", " ")}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Quick Actions">
          <QuickActions>
            <Button variant="secondary" href="/contacts">
              Contacts
            </Button>
            <Button variant="secondary" href="/pipeline">
              View pipeline
            </Button>
            <Button variant="secondary" href="/calendar">
              Open calendar
            </Button>
            <Button variant="secondary" href="/marketing">
              Marketing
            </Button>
          </QuickActions>
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        Sales-performance view (when enabled): F&amp;A | SALES &amp; LEAD PERFORMANCE.{" "}
        <Link href="/reporting">Reporting</Link> · <Link href="/training">Training</Link>
      </p>
    </AppShell>
  );
}

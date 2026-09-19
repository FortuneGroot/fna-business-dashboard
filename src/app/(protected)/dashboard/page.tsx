import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, MetricTile, Badge, EmptyState, QuickActions, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SidebarIcon } from "@/components/Sidebar";
import { getSyncStore } from "@/lib/sync";
import { clientBusinessName, platformProductName } from "@/lib/tenant";
import {
  SYNC_BANNER_ACTIVE,
  SYNC_SOURCE_DETAIL,
  syncBannerWaiting,
} from "@/lib/ui/sync-copy";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const store = getSyncStore();
  const summary = await store.summary();
  const events = await store.listAuditEvents(8);
  const conversations = await store.listConversationEvents(40);
  const reviews = await store.listReviewEvents(20);
  const waiting = summary.waitingForSync;
  const needsAttention = conversations.filter((c) =>
    /handoff|human|escalat/i.test(`${c.eventType || ""} ${c.summary || ""}`)
  );

  const metrics = [
    {
      label: "New Leads",
      value: waiting ? "—" : String(summary.contactsCount),
      note: "Contacts received from connected workflow sync.",
      icon: "contacts" as const,
      href: "/contacts",
    },
    {
      label: "Pipeline Value",
      value: waiting ? "—" : `$${summary.openPipelineValue.toLocaleString()}`,
      note: "Open opportunity value from synced opportunities.",
      icon: "opportunities" as const,
      href: "/pipeline",
    },
    {
      label: "Appointments",
      value: waiting ? "—" : String(summary.appointmentsCount),
      note: "Appointments synced from booking workflows.",
      icon: "calendar" as const,
      href: "/calendar",
    },
    {
      label: "Conversation Events",
      value: waiting ? "—" : String(summary.conversationEventsCount),
      note: "Inbound/outbound/handoff events (summary only).",
      icon: "conversations" as const,
      href: "/inbox",
    },
    {
      label: "Won Opportunities",
      value: waiting ? "—" : String(summary.wonCount),
      note: "Won events from opportunity sync.",
      icon: "reports" as const,
      href: "/reporting",
    },
    {
      label: "Last Sync Event",
      value: waiting ? "—" : summary.lastEventAt ? summary.lastEventAt.slice(0, 16).replace("T", " ") : "—",
      note: "Timestamp of the most recent synced update.",
      icon: "automations" as const,
      href: "/reporting",
    },
  ];

  return (
    <AppShell>
      <section className="hero">
        <Badge tone="gold">Business Dashboard</Badge>
        <h1 style={{ marginTop: "0.6rem" }}>{platformProductName()}</h1>
        <p>
          Client: <strong>{clientBusinessName()}</strong>. AUTOMATION · WEBSITES · BRANDING · SYSTEMS.
          {` ${SYNC_SOURCE_DETAIL}`}
        </p>
      </section>

      <StatusBanner>
        {waiting ? syncBannerWaiting("metrics") : SYNC_BANNER_ACTIVE}
      </StatusBanner>

      <div className="grid grid-4" style={{ marginTop: "1.1rem" }}>
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

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card
          title="Needs Attention"
          action={
            <Link href="/inbox" className="btn secondary sm">
              Conversations
            </Link>
          }
        >
          {waiting ? (
            <WaitingForSync entity="leads" />
          ) : needsAttention.length === 0 ? (
            <EmptyState
              title={`${summary.contactsCount} contact(s) synced`}
              note="No handoff or escalation events right now. Use Contacts and Opportunities for detail."
            />
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {needsAttention.slice(0, 6).map((c) => (
                <li key={c.id} className="muted">
                  {c.summary || c.eventType}
                  {c.timestamp ? ` · ${c.timestamp.slice(0, 16).replace("T", " ")}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Reviews"
          action={
            <Link href="/reviews" className="btn secondary sm">
              Open Reputation
            </Link>
          }
        >
          {waiting ? (
            <WaitingForSync entity="review events" />
          ) : (
            <EmptyState
              title={`${reviews.length} review event(s)`}
              note="Review request and feedback updates appear when reputation workflows send events."
            />
          )}
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
            <Button variant="secondary" href="/tasks">
              Tasks
            </Button>
            <Button variant="secondary" href="/marketing">
              Marketing
            </Button>
          </QuickActions>
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        Sales-performance view (when enabled): F&amp;A | SALES &amp; LEAD PERFORMANCE.{" "}
        <Link href="/reporting">Reporting</Link> · <Link href="/training">Training</Link> ·{" "}
        <Link href="/help">Help</Link>
      </p>
    </AppShell>
  );
}

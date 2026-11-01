import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, MetricTile, Badge, EmptyState, QuickActions, Button } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { SidebarIcon } from "@/components/Sidebar";
import { getPageData } from "@/lib/data";
import { platformProductName } from "@/lib/tenant";
import { dataCopy } from "@/lib/ui/sync-copy";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const data = await getPageData();
  const { reader, native } = data;
  const copy = dataCopy(native);
  const [summary, events, conversations, reviews, workspace] = await Promise.all([
    reader.summary(),
    reader.listAuditEvents(8),
    reader.listConversationEvents(40),
    reader.listReviewEvents(20),
    data.workspace(),
  ]);
  const waiting = summary.waitingForSync;
  const needsAttention = conversations.filter((c) =>
    /handoff|human|escalat/i.test(`${c.eventType || ""} ${c.summary || ""}`)
  );

  const metrics = [
    {
      label: "New Leads",
      value: waiting ? "—" : String(summary.contactsCount),
      note: native ? "Contacts in this workspace." : "Contacts received from connected workflow sync.",
      icon: "contacts" as const,
      href: "/contacts",
    },
    {
      label: "Pipeline Value",
      value: waiting ? "—" : `$${summary.openPipelineValue.toLocaleString()}`,
      note: native ? "Open opportunity value in this workspace." : "Open opportunity value from synced opportunities.",
      icon: "opportunities" as const,
      href: "/pipeline",
    },
    {
      label: "Appointments",
      value: waiting ? "—" : String(summary.appointmentsCount),
      note: native ? "Appointments on this workspace's calendars." : "Appointments synced from booking workflows.",
      icon: "calendar" as const,
      href: "/calendar",
    },
    {
      label: native ? "Messages" : "Conversation Events",
      value: waiting ? "—" : String(summary.conversationEventsCount),
      note: native ? "Inbound, outbound, and internal messages." : "Inbound/outbound/handoff events (summary only).",
      icon: "conversations" as const,
      href: "/inbox",
    },
    {
      label: "Won Opportunities",
      value: waiting ? "—" : String(summary.wonCount),
      note: native ? "Opportunities marked won." : "Won events from opportunity sync.",
      icon: "reports" as const,
      href: "/reporting",
    },
    {
      label: native ? "Last Activity" : "Last Sync Event",
      value: waiting ? "—" : summary.lastEventAt ? summary.lastEventAt.slice(0, 16).replace("T", " ") : "—",
      note: native ? "Timestamp of the most recent update in this workspace." : "Timestamp of the most recent synced update.",
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
          Client: <strong>{workspace.businessName}</strong>. AUTOMATION · WEBSITES · BRANDING · SYSTEMS.
          {` ${copy.sourceDetail}`}
        </p>
      </section>

      <StatusBanner>
        {waiting ? copy.bannerWaiting("metrics") : copy.bannerActive}
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
            <WaitingForSync entity="leads" native={native} />
          ) : needsAttention.length === 0 ? (
            <EmptyState
              title={native ? `${summary.contactsCount} contact(s)` : `${summary.contactsCount} contact(s) synced`}
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
            <WaitingForSync entity="review events" native={native} />
          ) : (
            <EmptyState
              title={native ? `${reviews.length} review(s)` : `${reviews.length} review event(s)`}
              note={
                native
                  ? "Reviews recorded for this workspace appear here."
                  : "Review request and feedback updates appear when reputation workflows send events."
              }
            />
          )}
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Recent Activity">
          {waiting || events.length === 0 ? (
            <WaitingForSync entity="activity" native={native} />
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

import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { PageHead, Card, Badge, EmptyState, MetricTile } from "@/components/ui";
import alerts from "@/content/alerts.json";
import emails from "@/content/emails.json";
import sms from "@/content/sms.json";
import snippets from "@/content/snippets.json";

/** Groups the 10 real internal alert types (src/content/alerts.json) into
 * the categories a client would recognize. Every alert currently has
 * activation "OFF" and channel "In-app/task; email and SMS OFF" — so every
 * category below is honestly labeled "Not yet active", not invented. */
const CATEGORIES: { name: string; note: string; alertIds: string[] }[] = [
  {
    name: "Lead Follow-Up",
    note: "Surfaces hot leads, replies, escalations, and proposal follow-ups as in-app tasks for staff to claim.",
    alertIds: ["ALERT-001", "ALERT-003", "ALERT-004", "ALERT-005", "ALERT-007", "ALERT-010"],
  },
  {
    name: "Appointment Reminders",
    note: "Flags new bookings and no-shows for staff review. No reminder currently sends automatically.",
    alertIds: ["ALERT-002", "ALERT-006"],
  },
  {
    name: "Review Requests",
    note: "Routes new review and feedback events to staff. Native review-request sending stays off.",
    alertIds: ["ALERT-008"],
  },
  {
    name: "Internal Alerts",
    note: "Tells staff when an automation needs a manual check instead of retrying blindly.",
    alertIds: ["ALERT-009"],
  },
];

export default function AutomationsPage() {
  return (
    <AppShell>
      <PageHead
        title="Automations"
        description="A status overview of the automated workflows planned for this account. This is not a workflow editor — nothing listed below is live yet."
      />

      <StatusBanner>
        Every automation below is drafted but not yet activated. Each one currently routes as an
        in-app/task notification only — email and SMS delivery stay switched off until launch.
      </StatusBanner>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        {CATEGORIES.map((cat) => {
          const items = alerts.filter((a) => cat.alertIds.includes(a.id));
          return (
            <Card key={cat.name} title={cat.name} action={<Badge tone="neutral">Not yet active</Badge>}>
              <p className="muted">{cat.note}</p>
              <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
                {items.map((a) => (
                  <li key={a.id} style={{ marginBottom: "0.3rem" }}>
                    <strong>{a.name}</strong> — {a.next}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Message Library">
          <p className="muted">
            Copy is drafted and ready to connect once workflows go live — nothing here sends on its own.
          </p>
          <div className="grid grid-3" style={{ marginTop: "0.75rem" }}>
            <MetricTile label="Email Templates" value={String(emails.length)} note="Drafted, not yet connected." />
            <MetricTile label="SMS Templates" value={String(sms.length)} note="Drafted, not yet connected." />
            <MetricTile label="Reply Snippets" value={String(snippets.length)} note="Ready for staff use in Conversations." />
          </div>
        </Card>
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Activity Log">
          <EmptyState
            title="No automation activity yet"
            note="Once workflows are activated, triggered events and staff actions will appear here."
          />
        </Card>
      </div>
    </AppShell>
  );
}

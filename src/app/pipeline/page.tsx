import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState, Badge } from "@/components/ui";

// Fortune & Automations Sales Pipeline (pipeline 6XevPh4T3rX0qAYRfuta) — bind by stage
// name, never column index. Order matches the live pipeline configuration.
const STAGES = [
  "New Lead",
  "Attempting Contact",
  "Connected",
  "Qualified",
  "Appointment Booked",
  "Appointment Completed",
  "Estimate / Proposal Sent",
  "Follow-Up",
  "Decision Pending",
  "Won",
  "Lost",
  "Long-Term Nurture",
];

export default function PipelinePage() {
  return (
    <AppShell>
      <PageHead
        title="Opportunities"
        description="Your sales board — the jobs and opportunities you are working, grouped by stage."
      />

      <StatusBanner>
        This is the Fortune &amp; Automations Sales Pipeline. Won is not cash in the bank until it
        is reconciled in Payments.
      </StatusBanner>

      <div
        style={{
          display: "flex",
          gap: "1rem",
          overflowX: "auto",
          paddingBottom: "0.5rem",
          marginTop: "1.1rem",
        }}
      >
        {STAGES.map((stage) => (
          <div key={stage} style={{ flex: "0 0 260px", minWidth: 0 }}>
            <Card title={stage} action={<Badge tone="neutral">$0</Badge>}>
              <EmptyState title="No opportunities yet" />
            </Card>
          </div>
        ))}
      </div>
    </AppShell>
  );
}

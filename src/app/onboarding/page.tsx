import { AppShell } from "@/components/AppShell";
import { Card, Badge, PageHead } from "@/components/ui";

const STEPS = [
  {
    title: "Connect your calendar",
    description: "Link a calendar so appointment requests can be reviewed and confirmed by your team.",
  },
  {
    title: "Add your first contact",
    description: "Bring in a real contact once the CRM connection is live — no sample data is seeded here.",
  },
  {
    title: "Set up automations",
    description: "Follow-up and reminder workflows turn on only after an owner explicitly approves them.",
  },
  {
    title: "Connect payments",
    description: "Invoicing and payment collection become available once a payment processor is connected.",
  },
];

export default function OnboardingPage() {
  return (
    <AppShell>
      <PageHead
        title="Onboarding / Setup Checklist"
        description="How Fortune & Automations typically gets set up. No prices or timelines are claimed here, and nothing below is marked done until it is genuinely connected."
      />

      <Card title="Setup steps">
        <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "1rem",
                padding: "0.9rem 0",
                borderBottom: i < STEPS.length - 1 ? "1px solid var(--line)" : undefined,
              }}
            >
              <div>
                <strong>
                  {i + 1}. {s.title}
                </strong>
                <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                  {s.description}
                </p>
              </div>
              <Badge tone="neutral">Pending</Badge>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Tell us what you need">
          <p>
            Submit a request about Automation, Websites, Branding, or Systems — or book a conversation
            if a time is available.
          </p>
        </Card>
        <Card title="Ask for a person anytime">
          <p>If you want a human, say so. Conversation AI stays off until an owner explicitly approves it.</p>
        </Card>
      </div>
    </AppShell>
  );
}

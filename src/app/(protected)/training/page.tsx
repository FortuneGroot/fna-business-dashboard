import { AppShell } from "@/components/AppShell";
import { PageHead, Card } from "@/components/ui";
import Link from "next/link";

export default function TrainingPage() {
  return (
    <AppShell>
      <PageHead
        title="Training"
        description="A short daily routine for your Fortune & Automations Business Dashboard."
      />

      <div className="grid">
        <Card title="Sign in">
          <p style={{ marginTop: 0 }}>
            Open <strong>app.fortuneandautomations.com</strong> in a browser and bookmark it on your
            phone. You do not need a separate CRM mobile app for this dashboard.
          </p>
        </Card>

        <Card title="Morning, 5 minutes">
          <ol>
            <li>Open Dashboard → Needs Attention</li>
            <li>Open Opportunities → unassigned New Lead</li>
            <li>Claim or assign one owner</li>
            <li>Open Conversations and answer anything waiting</li>
            <li>Check Calendars for today</li>
          </ol>
        </Card>

        <Card title="What this product is">
          <p style={{ marginTop: 0 }}>
            Your Fortune & Automations Business Dashboard. New customers from your website and forms
            show up here. Some follow-up can be automatic after Fortune & Automations turns it on
            with you. Until then, work the list like a shared inbox and a sales board.
          </p>
        </Card>

        <Card title="Please leave these to Fortune & Automations">
          <ul>
            <li>Automations and workflow publishing</li>
            <li>Website forms, funnel settings, and pipeline stage setup</li>
            <li>Phone numbers and sending email setup</li>
            <li>AI, missed-call, or review triggers</li>
            <li>Consent fields used for texts</li>
            <li>Dashboard widgets built for you</li>
          </ul>
          <p>
            It is OK to reply, add notes, move opportunities, update contact info, and complete
            tasks.
          </p>
        </Card>

        <Card title="Website change request">
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>
            {`Page or section:
What to change:
Must-have or nice-to-have:
Screenshot/link (if any):`}
          </pre>
        </Card>

        <Card title="Related">
          <p style={{ marginTop: 0 }}>
            <Link href="/onboarding">Onboarding</Link> · <Link href="/help">Help</Link> ·{" "}
            <Link href="/library">Resources</Link>
          </p>
        </Card>
      </div>
    </AppShell>
  );
}

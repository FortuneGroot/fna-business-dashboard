import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import Link from "next/link";

export default function TrainingPage() {
  return (
    <AppShell>
      <h1>Training</h1>
      <p>
        Intended login: <strong>app.fortuneandautomations.com</strong> in a browser. Bookmark that
        address on your phone. Do not install a third-party CRM mobile app for this dashboard.
      </p>
      <StatusBanner>
        This page recovers the 15–20 minute client training script. DNS and white-label login are
        not live yet. Google login stays off until the branded redirect is inspected.
      </StatusBanner>
      <div className="grid">
        <article className="card">
          <h2>Morning, 5 minutes</h2>
          <ol>
            <li>Open Dashboard → Needs Attention</li>
            <li>Open Pipeline → unassigned New Lead</li>
            <li>Claim or assign one owner</li>
            <li>Open Inbox and answer anything waiting</li>
            <li>Check Calendar for today</li>
          </ol>
        </article>
        <article className="card">
          <h2>What this product is</h2>
          <p>
            Your Fortune & Automations Business Dashboard. New customers from your website and
            forms show up here. Some follow-up can be automatic after Fortune & Automations turns
            it on with you. Until then, work the list like a shared inbox and a sales board.
          </p>
        </article>
        <article className="card">
          <h2>Please do not change</h2>
          <ul>
            <li>Automations (do not publish)</li>
            <li>Website forms, funnel publish settings, pipeline stages</li>
            <li>Phone numbers / sending email setup</li>
            <li>AI, missed-call, or review triggers</li>
            <li>Consent fields “to make texts work”</li>
            <li>Dashboard widgets Fortune & Automations built for you</li>
          </ul>
          <p>It is OK to reply, add notes, move opportunities, update contact info, and complete tasks.</p>
        </article>
        <article className="card">
          <h2>Website change request</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
            {`Page or section:
What to change:
Must-have or nice-to-have:
Screenshot/link (if any):`}
          </pre>
        </article>
        <article className="card">
          <h2>Also recovered</h2>
          <p>
            <Link href="/onboarding">Onboarding</Link> · <Link href="/help">Help</Link> ·{" "}
            <Link href="/library">Message library (internal drafts)</Link>
          </p>
        </article>
      </div>
    </AppShell>
  );
}

import { AppShell } from "@/components/AppShell";
import { Card, PageHead, Button } from "@/components/ui";
import { BRAND } from "@/lib/brand";

export default function HelpPage() {
  return (
    <AppShell>
      <PageHead
        title="Help & Support"
        description="Client-facing answers only. Vendor platform names are not used here. Empty topics stay empty rather than fabricated."
      />

      <div className="grid grid-3">
        <Card title="Getting Started">
          <p>
            Fortune & Automations (F&amp;A) is a B2B technology and services business offering
            Automation, Websites, Branding, and Systems work.
          </p>
          <p className="muted">{BRAND.voice}</p>
          <p>
            Sign in at <strong>{BRAND.appHost}</strong>. Bookmark it on your phone — no third-party
            CRM app is required for this dashboard.
          </p>
        </Card>

        <Card title="Contact Support">
          <p>
            Email: {BRAND.supportEmailRecovered || "Not yet configured"}
            <br />
            Phone: {BRAND.supportPhoneRecovered || "Not yet configured"}
          </p>
          <p className="muted">Recovered from the training pack — confirm live before publishing.</p>
          <Button variant="secondary" href="/support">
            Open the support form
          </Button>
        </Card>

        <Card title="Resources & Training">
          <p>Guides, templates, and walkthroughs for getting the most from your dashboard.</p>
          <div className="quick-actions">
            <Button variant="secondary" href="/library">
              Resource Library
            </Button>
            <Button variant="secondary" href="/training">
              Training
            </Button>
          </div>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Booking a conversation">
          <p>
            Use a calendar booking link when one is offered. A submitted form with a preferred time is
            not a confirmed appointment.
          </p>
        </Card>
        <Card title="Texts & emails">
          <p>
            You&apos;ll only hear from us if you opt in on an independent consent checkbox. A phone
            number or email by itself is not treated as marketing consent. Reply STOP to opt out of
            texts.
          </p>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="When should a person take over?">
          <p>
            If someone asks for a person, they are upset, you don&apos;t know the price, it is a
            current customer with a problem, or the dashboard flagged Needs Attention.
          </p>
        </Card>
        <Card title="Additional FAQs">
          <p className="muted">
            [Client confirmation required] — additional Q&amp;A stays empty until George approves real
            answers.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}

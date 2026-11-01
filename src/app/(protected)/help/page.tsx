import { AppShell } from "@/components/AppShell";
import { Card, PageHead, Button } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { getPageData } from "@/lib/data";
import { platformProductName } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function HelpPage() {
  const workspace = await (await getPageData()).workspace();
  const biz = workspace.businessName;
  const supportEmail = workspace.supportEmail;
  const phone = workspace.phone;
  const booking = workspace.bookingUrl;
  const product = platformProductName();

  return (
    <AppShell>
      <PageHead
        title="Help & Support"
        description={`${product} help for ${biz}. Empty topics stay empty rather than fabricated.`}
      />

      <div className="grid grid-3">
        <Card title="Getting Started">
          <p>
            You are using the <strong>{product}</strong> for{" "}
            <strong>{biz}</strong>
            {workspace.industry ? ` (${workspace.industry})` : ""}.
          </p>
          <p className="muted">{BRAND.voice}</p>
          <p>
            Sign in at <strong>{BRAND.appHost}</strong>. Bookmark it on your phone — no third-party
            CRM mobile app is required for this dashboard.
          </p>
        </Card>

        <Card title="Contact Support">
          <p>
            Email: {supportEmail || "Not yet configured"}
            <br />
            Phone: {phone || "Not yet configured"}
          </p>
          {!supportEmail && !phone ? (
            <p className="muted">Client support channels are not configured for this deployment yet.</p>
          ) : (
            <p className="muted">Contact details resolve from this deployment&apos;s client config.</p>
          )}
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
            <Button variant="secondary" href="/onboarding">
              Onboarding
            </Button>
          </div>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Booking a conversation">
          {booking ? (
            <p>
              Booking link:{" "}
              <a href={booking} rel="noreferrer" target="_blank">
                {booking}
              </a>
              . A submitted form with a preferred time is not a confirmed appointment.
            </p>
          ) : (
            <p className="muted">
              No booking URL is configured for this client yet. A form preferred-time is not a
              reserved appointment.
            </p>
          )}
        </Card>
        <Card title="Texts & emails">
          <p>
            You&apos;ll only hear from {biz} if you opt in on an independent consent checkbox. A phone
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
            Additional Q&amp;A stays empty until real client-approved answers are configured.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}

import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { PageHead, Card, EmptyState } from "@/components/ui";
import { SERVICES } from "@/lib/brand";

export default function MarketingPage() {
  return (
    <AppShell>
      <PageHead
        title="Marketing"
        description="Social planning and campaigns for your business, covering Automation, Websites, Branding, and Systems work. Nothing here is connected yet."
      />

      <StatusBanner>
        No social accounts or campaigns are connected in this shell. Nothing sends from this page.
      </StatusBanner>

      <div className="grid grid-2" style={{ marginTop: "1.1rem" }}>
        <Card title="Social Planner">
          <EmptyState
            title="No accounts connected yet"
            note="Connect a social account to plan and schedule posts here. Nothing is scheduled or posted until that happens."
          />
        </Card>
        <Card title="Campaigns">
          <EmptyState
            title="No campaigns yet"
            note="Marketing campaigns across your services will appear here once one is created."
          />
        </Card>
      </div>

      <p className="muted" style={{ marginTop: "1.1rem" }}>
        Service areas: {SERVICES.join(" · ")}.
      </p>
    </AppShell>
  );
}

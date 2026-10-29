import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { PageHead, Button } from "@/components/ui";
import Link from "next/link";

export function PlaceholderSurface({
  title,
  purpose,
  later,
}: {
  title: string;
  purpose: string;
  later: string;
}) {
  return (
    <AppShell>
      <PageHead title={title} description={purpose} />
      <StatusBanner>
        This area is a prepared shell from your training materials. Live customer data is not
        connected here yet.
      </StatusBanner>
      <div className="empty" role="status">
        <strong>Coming next</strong>
        <span>{later}</span>
        <Button variant="secondary" href="/dashboard">
          Back to dashboard
        </Button>
      </div>
      <p className="muted">
        Need help? <Link href="/help">Help &amp; Support</Link>
      </p>
    </AppShell>
  );
}

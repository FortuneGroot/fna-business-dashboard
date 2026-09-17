import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { PageHead, Card, MetricTile, EmptyState } from "@/components/ui";

const METRICS = [
  { label: "Review Count", value: "—", note: "Total public reviews once connected." },
  { label: "Average Rating", value: "—", note: "Across all connected review sources." },
  { label: "Response Rate", value: "—", note: "Share of reviews with a reply." },
];

export default function ReviewsPage() {
  return (
    <AppShell>
      <PageHead
        title="Reputation"
        description="Honest public reviews and private customer feedback. Nothing on this page is estimated — figures stay blank until a review source is connected."
      />

      <StatusBanner>
        Native review-request sending stays off while a custom workflow owns sending review requests
        instead.
      </StatusBanner>

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        {METRICS.map((m) => (
          <MetricTile key={m.label} label={m.label} value={m.value} note={m.note} />
        ))}
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Reviews">
          <EmptyState
            title="No reviews yet"
            note="Reputation is blocked on connecting your Google Business Profile. No review is shown or fabricated here in the meantime."
          />
        </Card>
      </div>
    </AppShell>
  );
}

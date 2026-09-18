import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { PageHead, Card, MetricTile, EmptyState, Badge } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";
import { clientReviewUrl } from "@/lib/tenant";
import { SYNC_SOURCE_SHORT, syncBannerWaiting } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function ReviewsPage() {
  const reviews = await getSyncStore().listReviewEvents(50);
  const waiting = reviews.length === 0;
  const requested = reviews.filter((r) => r.kind === "review-requested").length;
  const feedback = reviews.filter((r) => r.kind === "feedback-received").length;
  const reviewUrl = clientReviewUrl();

  const metrics = [
    {
      label: "Review events",
      value: waiting ? "—" : String(reviews.length),
      note: "Synced review request and feedback events only.",
    },
    {
      label: "Requests sent",
      value: waiting ? "—" : String(requested),
      note: "Review-request events received.",
    },
    {
      label: "Feedback received",
      value: waiting ? "—" : String(feedback),
      note: "Feedback-received events only.",
    },
  ];

  return (
    <AppShell>
      <PageHead title="Reputation" description={SYNC_SOURCE_SHORT} />

      <StatusBanner>
        {waiting
          ? syncBannerWaiting("review events")
          : `${reviews.length} review event(s) synced.${reviewUrl ? " Client review URL is configured." : ""}`}
      </StatusBanner>

      <div className="grid grid-3" style={{ marginTop: "1.1rem" }}>
        {metrics.map((m) => (
          <MetricTile key={m.label} label={m.label} value={m.value} note={m.note} />
        ))}
      </div>

      <div style={{ marginTop: "1.1rem" }}>
        <Card title="Review events" action={<Badge tone="neutral">{reviews.length}</Badge>}>
          {waiting ? (
            <WaitingForSync entity="review events" />
          ) : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {reviews.map((r) => (
                <li key={r.id} className="muted">
                  {r.kind}
                  {r.resultStatus ? ` · ${r.resultStatus}` : ""}
                  {r.timestamp ? ` · ${r.timestamp.slice(0, 16).replace("T", " ")}` : ""}
                </li>
              ))}
            </ul>
          )}
          {!waiting && reviews.length === 0 ? (
            <EmptyState
              title="No reviews yet"
              note="No review events have arrived yet."
            />
          ) : null}
        </Card>
      </div>
    </AppShell>
  );
}

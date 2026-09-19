import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState, Badge } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getSyncStore } from "@/lib/sync";
import {
  configuredPipelineName,
  configuredStageNames,
  looksLikePlaceholderStages,
} from "@/lib/tenant-ui";
import {
  PLACEHOLDER_CONFIG_STAGES,
  SYNC_SOURCE_SHORT,
  syncBannerWaiting,
  syncColumnEmpty,
} from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const opps = await getSyncStore().listOpportunities();
  const waiting = opps.length === 0;
  const stages = configuredStageNames();
  const pipelineName = configuredPipelineName();
  const stagesBlocked = looksLikePlaceholderStages();

  const byStage = (stage: string) =>
    opps.filter((o) => {
      const name = (o.stageName || o.status || "").toLowerCase();
      return name === stage.toLowerCase() || name.includes(stage.toLowerCase());
    });

  return (
    <AppShell>
      <PageHead
        title="Opportunities"
        description={`Your sales board — opportunities grouped by stage. ${SYNC_SOURCE_SHORT}`}
      />

      <StatusBanner>
        {stagesBlocked
          ? PLACEHOLDER_CONFIG_STAGES
          : waiting
            ? syncBannerWaiting("opportunities")
            : `${pipelineName} · ${opps.length} open item(s) across ${stages.length} stage(s). Won is not cash until reconciled in Payments.`}
      </StatusBanner>

      {!waiting && !stagesBlocked ? (
        <div className="grid grid-4" style={{ marginTop: "1.1rem" }}>
          {stages.slice(0, 4).map((stage) => {
            const items = byStage(stage);
            const value = items.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0);
            return (
              <Card key={`sum-${stage}`} title={stage}>
                <p style={{ margin: 0, fontSize: "1.4rem", fontFamily: "Libre Baskerville, Georgia, serif" }}>
                  {items.length}
                </p>
                <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                  ${value.toLocaleString()} combined
                </p>
              </Card>
            );
          })}
        </div>
      ) : null}

      {waiting ? (
        <div style={{ marginTop: "1.1rem" }}>
          <WaitingForSync entity="opportunities" />
        </div>
      ) : null}

      <div
        className="pipeline-board"
        style={{
          display: "flex",
          gap: "1rem",
          overflowX: "auto",
          paddingBottom: "0.5rem",
          marginTop: "1.1rem",
        }}
      >
        {stages.map((stage) => {
          const items = byStage(stage);
          const value = items.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0);
          return (
            <div key={stage} style={{ flex: "0 0 260px", minWidth: 0 }}>
              <Card title={stage} action={<Badge tone="neutral">${value.toLocaleString()}</Badge>}>
                {waiting ? (
                  <p className="muted" style={{ margin: 0 }}>
                    {syncColumnEmpty()}
                  </p>
                ) : items.length === 0 ? (
                  <EmptyState title="No opportunities yet" />
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                    {items.slice(0, 8).map((o) => (
                      <li key={o.externalOpportunityId} className="muted">
                        Opportunity
                        {o.monetaryValue != null ? ` · $${o.monetaryValue}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}

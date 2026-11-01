import { AppShell } from "@/components/AppShell";
import { StatusBanner } from "@/components/Chrome";
import { Card, PageHead, EmptyState, Badge } from "@/components/ui";
import { WaitingForSync } from "@/components/WaitingForSync";
import { getPageData } from "@/lib/data";
import { pipelineColumns } from "@/lib/ui/board";
import { PLACEHOLDER_CONFIG_STAGES, dataCopy, syncColumnEmpty } from "@/lib/ui/sync-copy";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const data = await getPageData();
  const { native } = data;
  const copy = dataCopy(native);
  const [opps, workspace, totals] = await Promise.all([
    data.reader.listOpportunities(),
    data.workspace(),
    data.stageTotals(),
  ]);
  const pipelineName = workspace.pipelineName;
  const stagesBlocked = !workspace.stagesConfigured;

  const columns = pipelineColumns({
    native,
    stages: workspace.stages,
    stageNames: workspace.stageNames,
    opportunities: opps,
    totals,
  });
  const boardCount = native ? columns.reduce((s, c) => s + c.count, 0) : opps.length;
  const waiting = boardCount === 0;

  return (
    <AppShell>
      <PageHead
        title="Opportunities"
        description={`Your sales board — opportunities grouped by stage. ${copy.sourceShort}`}
      />

      <StatusBanner>
        {stagesBlocked
          ? PLACEHOLDER_CONFIG_STAGES
          : waiting
            ? copy.bannerWaiting("opportunities")
            : native
              ? `${pipelineName} · ${boardCount} opportunit${boardCount === 1 ? "y" : "ies"} across ${columns.length} stage(s). Won is not cash until reconciled in Payments.`
              : `${pipelineName} · ${opps.length} open item(s) across ${columns.length} stage(s). Won is not cash until reconciled in Payments.`}
      </StatusBanner>

      {!waiting && !stagesBlocked ? (
        <div className="grid grid-4" style={{ marginTop: "1.1rem" }}>
          {columns.slice(0, 4).map((col) => (
            <Card key={`sum-${col.key}`} title={col.title}>
              <p style={{ margin: 0, fontSize: "1.4rem", fontFamily: "Libre Baskerville, Georgia, serif" }}>
                {col.count}
              </p>
              <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                ${col.value.toLocaleString()} combined
              </p>
            </Card>
          ))}
        </div>
      ) : null}

      {waiting ? (
        <div style={{ marginTop: "1.1rem" }}>
          <WaitingForSync entity="opportunities" native={native} />
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
        {columns.map((col) => {
          return (
            <div key={col.key} style={{ flex: "0 0 260px", minWidth: 0 }}>
              <Card title={col.title} action={<Badge tone="neutral">${col.value.toLocaleString()}</Badge>}>
                {waiting ? (
                  <p className="muted" style={{ margin: 0 }}>
                    {syncColumnEmpty()}
                  </p>
                ) : col.items.length === 0 ? (
                  <EmptyState title="No opportunities yet" />
                ) : (
                  <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                    {col.items.slice(0, 8).map((o) => (
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

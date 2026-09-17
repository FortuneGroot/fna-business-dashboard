import { NextResponse } from "next/server";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getSyncStore();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    opportunities: store.listOpportunities().map((o) => ({
      id: o.externalOpportunityId,
      contactId: o.contactId || "—",
      pipelineId: o.pipelineId || "—",
      stageId: o.stageId || "—",
      stageName: o.stageName || "—",
      status: o.status || "—",
      monetaryValue: o.monetaryValue ?? null,
      assignedUser: o.assignedUser || "—",
      updatedAt: o.updatedAt,
    })),
    waitingForSync: store.summary().waitingForSync,
  });
}

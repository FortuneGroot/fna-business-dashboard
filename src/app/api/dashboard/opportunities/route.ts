import { NextRequest } from "next/server";
import { readApi } from "@/lib/data/api";
import { opportunityRow, type OpportunitiesResponse } from "@/lib/data/dashboard-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return readApi(req, "pipeline.read", async ({ reader }): Promise<OpportunitiesResponse> => {
    const [opportunities, waitingForSync] = await Promise.all([reader.listOpportunities(), reader.waitingForSync()]);
    return {
      ok: true,
      source: reader.source,
      storageMode: reader.storageMode,
      opportunities: opportunities.map(opportunityRow),
      waitingForSync,
    };
  });
}

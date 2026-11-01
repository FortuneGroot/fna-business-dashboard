import { NextRequest } from "next/server";
import { readApi } from "@/lib/data/api";
import type { SummaryResponse } from "@/lib/data/dashboard-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return readApi(req, "dashboard.read", async ({ reader }): Promise<SummaryResponse> => ({
    ok: true,
    source: reader.source,
    storageMode: reader.storageMode,
    summary: await reader.summary(),
  }));
}

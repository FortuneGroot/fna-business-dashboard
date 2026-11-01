import { NextRequest } from "next/server";
import { readApi } from "@/lib/data/api";
import { eventRow, type EventsResponse } from "@/lib/data/dashboard-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return readApi(req, "dashboard.read", async ({ reader }): Promise<EventsResponse> => {
    const [events, waitingForSync] = await Promise.all([reader.listAuditEvents(100), reader.waitingForSync()]);
    return {
      ok: true,
      source: reader.source,
      storageMode: reader.storageMode,
      events: events.map(eventRow),
      waitingForSync,
    };
  });
}

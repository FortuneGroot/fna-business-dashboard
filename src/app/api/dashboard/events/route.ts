import { NextResponse } from "next/server";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getSyncStore();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    events: store.listAuditEvents(100).map((e) => ({
      id: e.id,
      eventType: e.eventType,
      receivedAt: e.receivedAt,
      locationId: e.locationId,
      entityRefs: e.entityRefs,
      note: e.note || "—",
    })),
    waitingForSync: store.summary().waitingForSync,
  });
}

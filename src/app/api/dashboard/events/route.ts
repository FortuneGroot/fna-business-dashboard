import { NextRequest, NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;
  const store = getSyncStore();
  const events = await store.listAuditEvents(100);
  const summary = await store.summary();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    storageMode: store.storageMode,
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      receivedAt: e.receivedAt,
      locationId: e.locationId,
      entityRefs: e.entityRefs,
      note: e.note || "—",
    })),
    waitingForSync: summary.waitingForSync,
  });
}

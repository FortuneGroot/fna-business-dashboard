import { NextResponse } from "next/server";
import { getSyncStore } from "@/lib/sync";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = getSyncStore();
  const conversations = await store.listConversationEvents(100);
  const summary = await store.summary();
  return NextResponse.json({
    ok: true,
    source: "sync-store",
    storageMode: store.storageMode,
    conversations: conversations.map((c) => ({
      id: c.id,
      contactId: c.contactId || "—",
      direction: c.direction || "unknown",
      channel: c.channel || "—",
      eventType: c.eventType,
      timestamp: c.timestamp,
      summary: c.summary || "—",
    })),
    waitingForSync: summary.waitingForSync,
  });
}

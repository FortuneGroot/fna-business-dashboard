import { NextRequest } from "next/server";
import { readApi } from "@/lib/data/api";
import { conversationRow, type ConversationsResponse } from "@/lib/data/dashboard-api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return readApi(req, "conversations.read", async ({ reader }): Promise<ConversationsResponse> => {
    const [conversations, waitingForSync] = await Promise.all([
      reader.listConversationEvents(100),
      reader.waitingForSync(),
    ]);
    return {
      ok: true,
      source: reader.source,
      storageMode: reader.storageMode,
      conversations: conversations.map(conversationRow),
      waitingForSync,
    };
  });
}

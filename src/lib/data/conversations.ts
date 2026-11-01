import "server-only";
import type { ConversationEventRecord } from "@/lib/data/records";
import {
  conversationEventRecord,
  type NativeConversationRow,
  type NativeMessageRow,
} from "./dashboard-adapters";
import { fromWorkspace, rows, type DataScope } from "./query";

/** Newest messages as conversation events (direction, channel, time; no message bodies). */
export async function listConversationEvents(scope: DataScope, limit = 100): Promise<ConversationEventRecord[]> {
  const messages = await rows<NativeMessageRow>(
    fromWorkspace(scope, "messages", "id, conversation_id, direction, created_at")
      .order("created_at", { ascending: false })
      .limit(limit),
    "messages"
  );
  const ids = [...new Set(messages.map((m) => m.conversation_id))];
  const conversations = ids.length
    ? await rows<NativeConversationRow>(
        fromWorkspace(scope, "conversations", "id, contact_id, channel").in("id", ids),
        "conversations"
      )
    : [];
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return messages.map((m) => conversationEventRecord(m, byId));
}

import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseId } from "@/lib/api/native";
import { addConversationNote, conversationNote } from "@/lib/native/conversations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** An internal note only: stored with direction `internal` and delivery `not_sent`; nothing is sent. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "conversations.write" }, async (scope) => {
    const conversationId = parseId(id);
    const { body } = await parseBody(req, conversationNote);
    return { message: await addConversationNote(scope, conversationId, body) };
  });
}

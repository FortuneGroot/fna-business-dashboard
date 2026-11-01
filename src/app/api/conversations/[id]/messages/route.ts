import type { NextRequest } from "next/server";
import { nativeApi, parseId, parseQuery } from "@/lib/api/native";
import { listMessages, messageListQuery } from "@/lib/native/conversations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "conversations.read" }, async (scope) => {
    const conversationId = parseId(id);
    return listMessages(scope, conversationId, parseQuery(req, messageListQuery));
  });
}

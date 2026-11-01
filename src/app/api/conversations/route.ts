import type { NextRequest } from "next/server";
import { nativeApi, parseQuery } from "@/lib/api/native";
import { conversationListQuery, listConversations } from "@/lib/native/conversations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "conversations.read" }, async (scope) => listConversations(scope, parseQuery(req, conversationListQuery)));
}

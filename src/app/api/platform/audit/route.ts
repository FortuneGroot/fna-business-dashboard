import type { NextRequest } from "next/server";
import { parseQuery } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { auditPage, auditQuery } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return platformApi(req, {}, async (scope) => auditPage(scope, null, parseQuery(req, auditQuery)));
}

import type { NextRequest } from "next/server";
import { parseId, parseQuery } from "@/lib/api/native";
import { platformApi } from "@/lib/api/platform";
import { auditPage, auditQuery } from "@/lib/platform/console";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return platformApi(req, {}, async (scope) => auditPage(scope, parseId(id), parseQuery(req, auditQuery)));
}

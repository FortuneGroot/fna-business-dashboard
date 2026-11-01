import type { NextRequest } from "next/server";
import { nativeApi, parseQuery } from "@/lib/api/native";
import { reportQuery, reportSummary } from "@/lib/native/reports";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "reports.read" }, async (scope) => reportSummary(scope, parseQuery(req, reportQuery)));
}

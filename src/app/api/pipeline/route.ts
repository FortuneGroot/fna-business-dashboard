import type { NextRequest } from "next/server";
import { nativeApi } from "@/lib/api/native";
import { getPipeline } from "@/lib/native/opportunities";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "pipeline.read" }, async (scope) => ({ pipeline: await getPipeline(scope) }));
}

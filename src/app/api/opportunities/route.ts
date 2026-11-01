import type { NextRequest } from "next/server";
import { nativeApi, parseBody, parseQuery } from "@/lib/api/native";
import { createOpportunity, listOpportunities, opportunityCreate, opportunityListQuery } from "@/lib/native/opportunities";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "pipeline.read" }, async (scope) => listOpportunities(scope, parseQuery(req, opportunityListQuery)));
}

export async function POST(req: NextRequest) {
  return nativeApi(req, { permission: "opportunities.write" }, async (scope) => {
    const input = await parseBody(req, opportunityCreate);
    return { opportunity: await createOpportunity(scope, input) };
  });
}

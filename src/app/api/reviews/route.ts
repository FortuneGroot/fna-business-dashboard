import type { NextRequest } from "next/server";
import { nativeApi, parseQuery } from "@/lib/api/native";
import { listReviews, reviewListQuery } from "@/lib/native/reviews";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "reviews.read" }, async (scope) => listReviews(scope, parseQuery(req, reviewListQuery)));
}

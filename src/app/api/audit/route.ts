import type { NextRequest } from "next/server";
import { z } from "zod";
import { nativeApi, pageQuery, parseQuery } from "@/lib/api/native";
import { listAudit } from "@/lib/native/audit";

export const dynamic = "force-dynamic";

const query = z.strictObject(pageQuery);

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "audit.read" }, async (scope) => listAudit(scope, parseQuery(req, query)));
}

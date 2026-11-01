import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { legacyOnlyEndpoint } from "@/lib/auth/legacy-only";
import { recentEvents } from "@/lib/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireApiRole(req, "OWNER");
  if (error) return error;
  const unavailable = legacyOnlyEndpoint();
  if (unavailable) return unavailable;
  return NextResponse.json({ events: recentEvents(50) });
}

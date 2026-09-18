import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import { recentEvents } from "@/lib/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { error } = await requireApiRole(req, "OWNER");
  if (error) return error;
  return NextResponse.json({ events: recentEvents(50) });
}

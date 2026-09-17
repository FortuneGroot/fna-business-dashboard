import { NextRequest, NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { recentEvents } from "@/lib/logging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireApiSession(req);
  if (denied) return denied;
  return NextResponse.json({ events: recentEvents(50) });
}

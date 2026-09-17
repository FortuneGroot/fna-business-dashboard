import { NextResponse } from "next/server";
import { recentEvents } from "@/lib/logging";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ events: recentEvents(50) });
}

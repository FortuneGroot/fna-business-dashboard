import { NextResponse } from "next/server";
import { checkGhlConnection, GhlRefusedError } from "@/lib/ghl";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await checkGhlConnection();
    return NextResponse.json(health);
  } catch (err) {
    const message = err instanceof Error ? err.message : "CRM health check failed";
    return NextResponse.json({ connected: false, error: message }, { status: 409 });
  }
}

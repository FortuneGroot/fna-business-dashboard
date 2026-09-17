import { NextRequest, NextResponse } from "next/server";
import { checkGhlConnection, GhlRefusedError } from "@/lib/ghl";
import { isAuthEnforced, readSessionFromCookieHeader } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Public callers get a sanitized summary (no location IDs / CRM names).
 * Authenticated callers (when AUTH_SECRET set) get the full health payload.
 */
export async function GET(req: NextRequest) {
  const enforced = isAuthEnforced();
  const session = enforced
    ? readSessionFromCookieHeader(req.headers.get("cookie"))
    : null;
  const privileged = !enforced || Boolean(session);

  try {
    const health = await checkGhlConnection();
    if (privileged) {
      return NextResponse.json(health);
    }
    return NextResponse.json({
      connected: health.connected,
      mode: health.mode,
      matchesConfigured: health.matchesConfigured,
      looksLikeMaster: health.looksLikeMaster,
      error: health.error
        ? "CRM health check failed (details require sign-in)"
        : null,
      locationId: health.locationId ? "[redacted]" : "",
      locationName: null,
      httpStatus: health.httpStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "CRM health check failed";
    const refused = err instanceof GhlRefusedError;
    return NextResponse.json(
      {
        connected: false,
        error: privileged ? message : "CRM health check failed",
        refused,
      },
      { status: 409 }
    );
  }
}

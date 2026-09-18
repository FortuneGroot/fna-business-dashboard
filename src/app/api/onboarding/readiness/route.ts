import { NextRequest, NextResponse } from "next/server";
import { requireApiRole } from "@/lib/auth";
import {
  evaluateClientReadiness,
  toPublicReadinessPayload,
} from "@/lib/onboarding";
import { getTenantConfig } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * Config-only onboarding readiness — same tenant model as runtime.
 * Never exposes webhook secrets, Supabase keys, GHL tokens, or passwords.
 * OWNER only.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireApiRole(req, "OWNER");
  if (error) return error;
  const config = getTenantConfig();
  const report = evaluateClientReadiness(config);
  const payload = toPublicReadinessPayload(report);

  const body = {
    ...payload,
    source: "tenant-config",
    configuredLocationId: config.ghl.locationId,
  };

  const text = JSON.stringify(body);
  if (/SUPABASE_SERVICE_ROLE|GHL_API_TOKEN|pit-[A-Za-z0-9]|webhookSecret"\s*:\s*"[^"]+"/i.test(text)) {
    return NextResponse.json(
      { ok: false, error: "Refusing response that may contain secrets" },
      { status: 500 }
    );
  }

  return NextResponse.json(body);
}

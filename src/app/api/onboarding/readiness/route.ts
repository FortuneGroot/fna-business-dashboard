import { NextResponse } from "next/server";
import {
  evaluateClientReadiness,
  loadResolvedClientConfig,
  toPublicReadinessPayload,
} from "@/lib/onboarding";

export const dynamic = "force-dynamic";

/**
 * Config-only onboarding readiness.
 * Never exposes webhook secrets, Supabase keys, GHL tokens, or passwords.
 */
export async function GET() {
  const { config, path } = loadResolvedClientConfig(process.cwd(), process.env);
  const report = evaluateClientReadiness(config);
  const payload = toPublicReadinessPayload(report);

  const body = {
    ...payload,
    configPath: path ? path.replace(/\\/g, "/").split("/").slice(-3).join("/") : null,
    source: "client-config",
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

import { NextResponse } from "next/server";
import { loadEnv, validateEnv } from "@/lib/env";
import { checkGhlConnection, GhlRefusedError } from "@/lib/ghl";
import { logEvent } from "@/lib/logging";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";

export async function GET() {
  const env = loadEnv();
  const envErrors = validateEnv(env);
  let ghl;
  try {
    ghl = await checkGhlConnection();
  } catch (err) {
    const message = err instanceof GhlRefusedError ? err.message : "CRM health check failed";
    ghl = { connected: false, mode: "unconfigured", error: message, locationId: env.locationId };
    logEvent("health.ghl_refused", { message }, { level: "error" });
  }

  const body = {
    ok: envErrors.length === 0,
    service: "fna-client-app",
    brand: BRAND.name,
    product: BRAND.product,
    intendedHost: BRAND.appHost,
    dryRun: env.dryRun,
    allowProductionWrites: env.allowProductionWrites,
    envErrors,
    ghl,
    ts: new Date().toISOString(),
  };
  logEvent("health.ok", { dryRun: env.dryRun, tokenPresent: env.tokenPresent });
  return NextResponse.json(body);
}

import { NextRequest, NextResponse } from "next/server";
import { loadEnv, validateEnv } from "@/lib/env";
import { checkGhlConnection, GhlRefusedError } from "@/lib/ghl";
import { logEvent } from "@/lib/logging";
import { BRAND } from "@/lib/brand";
import { isAuthEnforced, mustProtectRoutes, readSessionFromCookieHeader } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const env = loadEnv();
  const envErrors = validateEnv(env);
  const enforced = isAuthEnforced();
  const session = enforced
    ? await readSessionFromCookieHeader(req.headers.get("cookie"))
    : null;
  const privileged = Boolean(session) || (!enforced && !mustProtectRoutes());

  let ghlConnected = false;
  let ghlMode: string = "unconfigured";
  try {
    const ghl = await checkGhlConnection();
    ghlConnected = Boolean(ghl.connected);
    ghlMode = ghl.mode;
    if (privileged) {
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
      logEvent("health.ok", { dryRun: env.dryRun, privileged: true });
      return NextResponse.json(body);
    }
  } catch (err) {
    const message = err instanceof GhlRefusedError ? err.message : "CRM health check failed";
    logEvent("health.ghl_refused", { message }, { level: "error" });
    if (privileged) {
      return NextResponse.json({
        ok: false,
        service: "fna-client-app",
        product: BRAND.product,
        dryRun: env.dryRun,
        envErrors,
        ghl: { connected: false, mode: "unconfigured", error: message },
        ts: new Date().toISOString(),
      });
    }
  }

  // Anonymous public health — no location/pipeline/secret presence details.
  const body = {
    ok: envErrors.length === 0 && !env.allowProductionWrites,
    service: "fna-client-app",
    product: BRAND.product,
    up: true,
    dryRun: env.dryRun,
    crmReachable: ghlConnected,
    crmMode: ghlMode === "live-read" || ghlMode === "dry-run" ? ghlMode : "unconfigured",
    envOk: envErrors.length === 0,
    ts: new Date().toISOString(),
  };
  logEvent("health.ok", { dryRun: env.dryRun, privileged: false });
  return NextResponse.json(body);
}

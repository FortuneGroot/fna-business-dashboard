import { NextRequest, NextResponse } from "next/server";
import { loadEnv, validateEnv } from "@/lib/env";
import { checkGhlConnection, GhlRefusedError } from "@/lib/ghl";
import { logEvent } from "@/lib/logging";
import { BRAND } from "@/lib/brand";
import { isAuthEnforced, mustProtectRoutes, readSessionFromCookieHeader } from "@/lib/auth";
import { authProvider, supabaseAuthConfig } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

/**
 * AUTH_PROVIDER=supabase (spec §7.3): public `{ ok, db, authProvider }`. The database is probed with
 * the anon key only; any answer from the database API (including a refusal) means it is reachable.
 */
async function supabaseHealth(): Promise<NextResponse> {
  const config = supabaseAuthConfig();
  let db: "ok" | "error" = "error";
  if (config) {
    try {
      const res = await fetch(`${config.url}/rest/v1/rpc/request_context`, {
        method: "POST",
        headers: { apikey: config.anonKey, "content-type": "application/json" },
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      db = res.status < 500 ? "ok" : "error";
    } catch {
      db = "error";
    }
  }
  logEvent("health.ok", { authProvider: "supabase", db });
  return NextResponse.json(
    { ok: db === "ok", service: "fna-client-app", db, authProvider: "supabase", ts: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(req: NextRequest) {
  if (authProvider() === "supabase") return supabaseHealth();
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

import { NextRequest, NextResponse } from "next/server";
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

/**
 * AUTH_PROVIDER=legacy: the app answers with no outbound call (the CRM connection was retired in P7).
 * Signed-in callers also learn the brand and where the frozen snapshot is read from.
 */
export async function GET(req: NextRequest) {
  if (authProvider() === "supabase") return supabaseHealth();
  const enforced = isAuthEnforced();
  const session = enforced
    ? await readSessionFromCookieHeader(req.headers.get("cookie"))
    : null;
  const privileged = Boolean(session) || (!enforced && !mustProtectRoutes());
  const base = { ok: true, service: "fna-client-app", product: BRAND.product, authProvider: "legacy" };
  logEvent("health.ok", { authProvider: "legacy", privileged });
  if (!privileged) return NextResponse.json({ ...base, up: true, ts: new Date().toISOString() });
  const { isSupabaseConfigured } = await import("@/lib/legacy/rest-client");
  return NextResponse.json({
    ...base,
    brand: BRAND.name,
    intendedHost: BRAND.appHost,
    storageMode: isSupabaseConfigured() ? "postgres" : "memory",
    ts: new Date().toISOString(),
  });
}

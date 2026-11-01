import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { requireApiSession } from "@/lib/auth/guards";
import { authProvider } from "@/lib/auth/provider";
import type { RequestContext } from "@/lib/authz/evaluate";
import { DataUnavailableError } from "./query";
import type { DataSource } from "./types";

export type ApiData = DataSource & { readonly ctx: RequestContext | null };

/**
 * Shared handler for read APIs. AUTH_PROVIDER=supabase: requires `permission` in the active workspace
 * (§7.1 error codes), reads native tables with the user's JWT, applies refreshed session cookies, and
 * answers 503 `unavailable` when the database cannot. AUTH_PROVIDER=legacy: the existing session
 * check and the frozen sync snapshot.
 */
export async function readApi(
  req: NextRequest,
  permission: string,
  build: (data: ApiData) => Promise<Record<string, unknown>>
): Promise<NextResponse> {
  if (authProvider() === "supabase") {
    const { requireApiContext, unavailableResponse } = await import("@/lib/authz/context");
    const { applyPendingCookies } = await import("@/lib/supabase/server");
    const { nativeDataSource } = await import("./native");
    const { ctx, supabase, pending, error } = await requireApiContext(req, { permission });
    if (error) return error;
    try {
      const body = await build({ ...nativeDataSource({ supabase: supabase!, ctx: ctx! }), ctx });
      return applyPendingCookies(
        NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } }),
        pending
      );
    } catch (err) {
      if (err instanceof DataUnavailableError) return applyPendingCookies(unavailableResponse(), pending);
      throw err;
    }
  }
  const denied = await requireApiSession(req);
  if (denied) return denied;
  const { legacyDataSource } = await import("./legacy");
  return NextResponse.json(await build({ ...legacyDataSource(), ctx: null }));
}

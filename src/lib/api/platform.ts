import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authProvider } from "@/lib/auth/provider";
import { ApiError, dbFailure, errorResponse, forbidden, notFound } from "@/lib/api/native";
import type { RequestContext } from "@/lib/authz/evaluate";

export type PlatformScope = { supabase: SupabaseClient; ctx: RequestContext };

export const mfaRequired = () =>
  new ApiError(403, "mfa_required", "Verify your authenticator app to use platform administration");

export type PlatformStatus = { listed: boolean; aal: string; active: boolean };

export async function platformStatus(supabase: SupabaseClient): Promise<PlatformStatus> {
  const res = await supabase.rpc("platform_status");
  if (res.error) throw dbFailure(res.error);
  const raw = (res.data ?? {}) as Partial<PlatformStatus>;
  return { listed: raw.listed === true, aal: String(raw.aal ?? "aal1"), active: raw.active === true };
}

/**
 * Shared handler for /api/platform/* (§7.5). Requires AUTH_PROVIDER=supabase (404 otherwise), a valid
 * session, and active platform authority (a platform_admins row and an AAL2 session, decided by the
 * database). No workspace membership is needed or used. A listed admin with an AAL1 session gets 403
 * `mfa_required`; everyone else 403 `forbidden`. Sensitive actions re-check the session with the Auth
 * server first. The RPCs re-check platform authority under the caller's JWT.
 */
export async function platformApi(
  req: NextRequest,
  options: { sensitive?: boolean },
  run: (scope: PlatformScope) => Promise<Record<string, unknown>>
): Promise<NextResponse> {
  if (authProvider() !== "supabase") return errorResponse(notFound());
  const { requireApiContext, sessionStillValid, denialResponse } = await import("@/lib/authz/context");
  const { applyPendingCookies } = await import("@/lib/supabase/server");
  const { ctx, supabase, pending, error } = await requireApiContext(req, { allowNoWorkspace: true });
  if (error) return error;
  const reply = (res: NextResponse) => applyPendingCookies(res, pending);
  try {
    if (!ctx!.isPlatformAdmin) {
      const status = await platformStatus(supabase!);
      return reply(errorResponse(status.listed ? mfaRequired() : forbidden()));
    }
    if (options.sensitive && !(await sessionStillValid(supabase!, ctx!))) return reply(denialResponse("unauthenticated"));
    const body = await run({ supabase: supabase!, ctx: ctx! });
    return reply(NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "private, no-store" } }));
  } catch (err) {
    if (err instanceof ApiError) return reply(errorResponse(err));
    throw err;
  }
}

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authProvider } from "@/lib/auth/provider";
import { ApiError, errorResponse, forbidden, invalid, notFound, uuid } from "@/lib/api/native";
import { platformStatus, type PlatformStatus } from "@/lib/api/platform";

export const verifyBody = z.strictObject({
  factorId: uuid,
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
});

export type Factor = { id: string; friendlyName: string | null; createdAt: string };

type AuthFailure = { status?: number; code?: string } | null;

/** GoTrue MFA failures: bad or expired codes are 422, throttling 429, anything else 503. */
export function mfaFailure(error: AuthFailure): ApiError {
  const status = error?.status ?? 0;
  if (status === 429) return new ApiError(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  if (status === 400 || status === 422 || /mfa_(verification_failed|challenge_expired)|invalid/i.test(error?.code ?? "")) {
    return invalid({ code: "That code is not valid. Enter the current code from your authenticator app." });
  }
  return new ApiError(503, "unavailable", "Service temporarily unavailable");
}

/**
 * Handler for /api/auth/mfa/*: supabase mode only (404 otherwise), a valid session, and a listed
 * platform admin (MFA is how platform authority is reached; ordinary members get 403). Session cookie
 * changes — including the AAL2 session after verification — are applied to the response.
 */
export async function mfaApi(
  req: NextRequest,
  run: (supabase: SupabaseClient, status: PlatformStatus) => Promise<Record<string, unknown>>
): Promise<NextResponse> {
  if (authProvider() !== "supabase") return errorResponse(notFound());
  const { requireApiContext } = await import("@/lib/authz/context");
  const { applyPendingCookies } = await import("@/lib/supabase/server");
  const { supabase, pending, error } = await requireApiContext(req, { allowNoWorkspace: true });
  if (error) return error;
  const reply = (res: NextResponse) => applyPendingCookies(res, pending);
  try {
    const status = await platformStatus(supabase!);
    if (!status.listed) return reply(errorResponse(forbidden()));
    const body = await run(supabase!, status);
    return reply(NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "private, no-store" } }));
  } catch (err) {
    if (err instanceof ApiError) return reply(errorResponse(err));
    throw err;
  }
}

/** Verified TOTP factors (no secrets). */
export async function verifiedFactors(supabase: SupabaseClient): Promise<Factor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw mfaFailure(error);
  return (data?.totp ?? []).map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null, createdAt: f.created_at }));
}

/**
 * Starts TOTP enrollment. Abandoned (unverified) enrollments are removed first. The QR code and setup
 * key are returned to the enrolling user only, once; GoTrue keeps the factor unverified until a
 * correct code is entered.
 */
export async function enrollTotp(supabase: SupabaseClient) {
  if ((await verifiedFactors(supabase)).length) {
    throw new ApiError(409, "factor_exists", "An authenticator is already set up. Enter its current code instead.");
  }
  const listed = await supabase.auth.mfa.listFactors();
  if (listed.error) throw mfaFailure(listed.error);
  for (const f of listed.data?.all ?? []) {
    if (f.factor_type === "totp" && f.status !== "verified") {
      const removed = await supabase.auth.mfa.unenroll({ factorId: f.id });
      if (removed.error) throw mfaFailure(removed.error);
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Platform authenticator" });
  if (error || !data) throw mfaFailure(error);
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
}

/** Challenges and verifies one factor; on success the session (and its cookies) become AAL2. */
export async function verifyTotp(supabase: SupabaseClient, input: z.infer<typeof verifyBody>) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: input.factorId, code: input.code });
  if (error) throw mfaFailure(error);
  const status = await platformStatus(supabase);
  return { aal: status.aal, platformActive: status.active };
}

import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  getAuthSecret,
  revokeSessionToken,
  sessionCookieOptions,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Logout always clears the browser cookie.
 * Durable server-side revocation is reported honestly:
 * - durableRevoked=true → copied old cookies must fail Edge/Node verify
 * - durableRevoked=false → cookie cleared locally, but replay may still work until TTL
 *   if the durable store revoke failed or no session cookie was present
 */
export async function POST(req: NextRequest) {
  const secret = getAuthSecret();
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  let durableRevoked = false;
  let durableRevokeStatus: "revoked" | "failed" | "skipped_no_cookie" | "skipped_no_secret" =
    "skipped_no_secret";

  if (!secret) {
    durableRevokeStatus = "skipped_no_secret";
  } else if (!cookie) {
    durableRevokeStatus = "skipped_no_cookie";
  } else {
    try {
      const result = await revokeSessionToken(cookie, secret);
      durableRevoked = result.durableRevoked;
      durableRevokeStatus = result.durableRevoked ? "revoked" : "failed";
    } catch (error) {
      durableRevoked = false;
      durableRevokeStatus = "failed";
      console.error(
        "[auth/logout] durable session revoke failed",
        error instanceof Error ? error.message : "unknown error"
      );
    }
  }

  const res = NextResponse.json({
    ok: true,
    loggedOut: true,
    cookieCleared: true,
    durableRevoked,
    durableRevokeStatus,
  });
  // Always clear the client cookie — even if durable revoke fails —
  // so a stale browser cookie cannot remain "logged in" after logout.
  res.cookies.set(AUTH_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return res;
}

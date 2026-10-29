import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  getAuthSecret,
  revokeSessionToken,
  sessionCookieOptions,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = getAuthSecret();
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  const res = NextResponse.json({ ok: true, loggedOut: true });
  // Always clear the client cookie — even if durable revoke fails —
  // so a stale browser cookie cannot remain "logged in" after logout.
  res.cookies.set(AUTH_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  try {
    if (secret && cookie) {
      await revokeSessionToken(cookie, secret);
    }
  } catch (error) {
    console.error(
      "[auth/logout] durable session revoke failed",
      error instanceof Error ? error.message : "unknown error"
    );
  }
  return res;
}

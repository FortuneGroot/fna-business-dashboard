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
  if (secret && cookie) {
    await revokeSessionToken(cookie, secret);
  }
  const res = NextResponse.json({ ok: true, loggedOut: true });
  res.cookies.set(AUTH_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return res;
}

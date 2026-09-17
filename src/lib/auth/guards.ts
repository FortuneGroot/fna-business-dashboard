import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  getAuthSecret,
  mustProtectRoutes,
  readSessionFromCookieHeader,
  verifySessionToken,
} from "./session";

/** Final page authorization. Middleware is only an early signature/expiry filter. */
export async function requirePageSession(): Promise<void> {
  const secret = getAuthSecret();
  if (!secret) {
    if (mustProtectRoutes()) redirect("/login?error=auth_misconfigured");
    return;
  }

  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  if (!token || !(await verifySessionToken(token, secret))) {
    redirect("/login");
  }
}

/** Final API authorization using the revocation-aware session store. */
export async function requireApiSession(
  req: NextRequest
): Promise<NextResponse | null> {
  const secret = getAuthSecret();
  if (!secret) {
    if (mustProtectRoutes()) {
      return NextResponse.json(
        { ok: false, error: "Authentication misconfigured" },
        { status: 503 }
      );
    }
    return null;
  }

  const session = await readSessionFromCookieHeader(req.headers.get("cookie"));
  return session
    ? null
    : NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

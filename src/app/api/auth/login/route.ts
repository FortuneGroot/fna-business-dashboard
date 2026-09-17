import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  authenticateCredentials,
  createSessionToken,
  getAuthSecret,
  isAuthEnforced,
  sessionCookieOptions,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isAuthEnforced()) {
    return NextResponse.json(
      {
        ok: false,
        error: "Authentication is not configured. Set AUTH_SECRET and owner credentials.",
      },
      { status: 503 }
    );
  }

  let body: { email?: string; password?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || !password) {
    return NextResponse.json({ ok: false, error: "Email and password required" }, { status: 400 });
  }

  const user = authenticateCredentials(email, password);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
  }

  const token = createSessionToken(user, getAuthSecret());
  const res = NextResponse.json({
    ok: true,
    user: { email: user.email, role: user.role, name: user.name },
  });
  res.cookies.set(AUTH_COOKIE, token, sessionCookieOptions());
  return res;
}

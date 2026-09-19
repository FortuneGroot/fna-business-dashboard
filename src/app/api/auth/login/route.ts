import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  authenticateCredentials,
  consumeLoginAttempt,
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

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

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

  const rl = consumeLoginAttempt(`login:${ip}:${email.toLowerCase()}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  const user = authenticateCredentials(email, password);
  if (!user) {
    return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
  }

  let token: string;
  try {
    token = await createSessionToken(user, getAuthSecret());
  } catch (error) {
    // Safe diagnostic only: createSessionToken errors contain no credentials,
    // secret values, cookies, or session IDs.
    console.error(
      "[auth/login] durable session creation failed",
      error instanceof Error ? error.message : "unknown error"
    );
    return NextResponse.json(
      {
        ok: false,
        error: "Unable to create a durable login session. Try again or contact support.",
      },
      { status: 503 }
    );
  }
  const res = NextResponse.json({
    ok: true,
    user: { email: user.email, role: user.role, name: user.name },
  });
  res.cookies.set(AUTH_COOKIE, token, sessionCookieOptions());
  return res;
}

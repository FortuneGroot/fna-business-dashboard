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
import { authProvider, supabaseAuthConfig } from "@/lib/auth/provider";
import { applyPendingCookies, supabaseForRequest } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** AUTH_PROVIDER=supabase: same request/response shape; Supabase Auth rate limits apply (§5.1). */
async function supabaseLogin(req: NextRequest): Promise<NextResponse> {
  const config = supabaseAuthConfig();
  if (!config) {
    return NextResponse.json(
      { ok: false, error: "Authentication misconfigured", code: "auth_misconfigured" },
      { status: 503 }
    );
  }
  let body: { email?: string; password?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON", code: "validation_failed" }, { status: 400 });
  }
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "Email and password required", code: "validation_failed" },
      { status: 400 }
    );
  }

  const { supabase, pending } = supabaseForRequest(req.headers.get("cookie"), config);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (error?.status === 429) {
      return NextResponse.json(
        { ok: false, error: "Too many attempts. Try again later.", code: "rate_limited" },
        { status: 429 }
      );
    }
    if (error && (!error.status || error.status >= 500 || error.name === "AuthRetryableFetchError")) {
      return NextResponse.json(
        { ok: false, error: "Sign-in is temporarily unavailable. Try again shortly.", code: "unavailable" },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, error: "Invalid credentials", code: "unauthenticated" }, { status: 401 });
  }
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim() : data.user.email ?? email;
  const res = NextResponse.json({ ok: true, user: { id: data.user.id, email: data.user.email ?? email, name } });
  res.headers.set("Cache-Control", "private, no-store");
  return applyPendingCookies(res, pending);
}

export async function POST(req: NextRequest) {
  const provider = authProvider();
  if (provider === "supabase") return supabaseLogin(req);
  if (provider === null) {
    return NextResponse.json(
      { ok: false, error: "Authentication misconfigured", code: "auth_misconfigured" },
      { status: 503 }
    );
  }
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

import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  getCookieValue,
  isStoredSessionActiveEdge,
  verifySessionTokenEdge,
} from "@/lib/auth/session-edge";

/** Paths that never require a session (machine or public). */
const PUBLIC_EXACT = new Set([
  "/login",
  "/privacy",
  "/terms",
  "/api/health",
  "/api/ghl/health",
  "/api/webhooks/ghl",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/tenant/public",
  "/api/leads",
]);

const PUBLIC_PREFIXES = ["/api/auth/"];

const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/contacts",
  "/pipeline",
  "/calendar",
  "/inbox",
  "/reporting",
  "/tasks",
  "/reviews",
  "/settings",
  "/support",
  "/training",
  "/library",
  "/automations",
  "/marketing",
  "/payments",
  "/onboarding",
  "/help",
];

const PROTECTED_API_PREFIXES = [
  "/api/dashboard",
  "/api/events",
  "/api/sync/health",
  "/api/onboarding/readiness",
  "/api/auth/me",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function isProtectedPage(pathname: string): boolean {
  if (pathname === "/") return true;
  return PROTECTED_PAGE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

function isProtectedApi(pathname: string): boolean {
  return PROTECTED_API_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

function mustProtect(): boolean {
  const secret = (process.env.AUTH_SECRET || "").trim();
  if (secret) return true;
  const vercelEnv = (process.env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercelEnv === "production") return true;
  if ((process.env.AUTH_FAIL_CLOSED || "").toLowerCase() === "true") return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const needsAuth = isProtectedPage(pathname) || isProtectedApi(pathname);
  if (!needsAuth) {
    return NextResponse.next();
  }

  if (!mustProtect()) {
    // Preview/local without AUTH_SECRET and without fail-closed → open
    // (Vercel Deployment Protection remains the Preview gate).
    return NextResponse.next();
  }

  const secret = (process.env.AUTH_SECRET || "").trim();
  if (!secret) {
    // Production / fail-closed without AUTH_SECRET — never public.
    if (isProtectedApi(pathname)) {
      return NextResponse.json(
        { ok: false, error: "Authentication misconfigured" },
        { status: 503 }
      );
    }
    const login = new URL("/login", req.url);
    login.searchParams.set("error", "auth_misconfigured");
    return NextResponse.redirect(login);
  }

  const token = getCookieValue(req.headers.get("cookie"), AUTH_COOKIE);
  const session = token ? await verifySessionTokenEdge(token, secret) : null;
  const ok = Boolean(session && (await isStoredSessionActiveEdge(session.sid)));

  if (ok) {
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  if (isProtectedApi(pathname)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname === "/" ? "/dashboard" : pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/contacts/:path*",
    "/pipeline/:path*",
    "/calendar/:path*",
    "/inbox/:path*",
    "/reporting/:path*",
    "/tasks/:path*",
    "/reviews/:path*",
    "/settings/:path*",
    "/support/:path*",
    "/training/:path*",
    "/library/:path*",
    "/automations/:path*",
    "/marketing/:path*",
    "/payments/:path*",
    "/onboarding/:path*",
    "/help/:path*",
    "/api/dashboard/:path*",
    "/api/events",
    "/api/sync/health",
    "/api/onboarding/readiness",
    "/api/auth/me",
  ],
};

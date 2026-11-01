import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  AUTH_COOKIE,
  getCookieValue,
  isStoredSessionActiveEdge,
  verifySessionTokenEdge,
} from "@/lib/auth/session-edge";
import { authProvider, supabaseAuthConfig, supabaseCookieOptions } from "@/lib/auth/provider";
import { contextFromRpc, denialRedirect, evaluateContext, pagePermission } from "@/lib/authz/evaluate";

/** Paths that never require a session (machine or public). */
const PUBLIC_EXACT = new Set([
  "/login",
  "/privacy",
  "/terms",
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  // Probe endpoint for login UI — route handler reports authEnforced / session.
  // Must not be middleware-blocked with a bare 401 (that falsely looks like "auth off").
  "/api/auth/me",
  "/api/tenant/public",
]);

const PUBLIC_PREFIXES: string[] = [];

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

/** Native-only APIs (§7.4); their route handlers answer 404 in legacy mode. */
const NATIVE_API_PREFIXES = [
  "/api/team",
  "/api/settings",
  "/api/integrations",
  "/api/audit",
  "/api/onboarding/checklist",
  "/api/contacts",
  "/api/pipeline",
  "/api/opportunities",
  "/api/calendars",
  "/api/appointments",
  "/api/conversations",
  "/api/tasks",
  "/api/reviews",
  "/api/reports",
];

const PROTECTED_API_PREFIXES = [
  "/api/dashboard",
  "/api/tenant/config",
  "/api/workspaces",
  "/api/platform",
  ...NATIVE_API_PREFIXES,
];

/**
 * Signed-in pages that need no workspace (AUTH_PROVIDER=supabase only). The platform console decides
 * platform authority (listed admin + AAL2) in its own pages and APIs, never from membership.
 */
const SESSION_ONLY_PAGES = ["/no-access", "/workspace-suspended", "/platform"];

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

function loginRedirect(req: NextRequest, pathname: string): NextResponse {
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname === "/" ? "/dashboard" : pathname);
  return NextResponse.redirect(login);
}

function misconfigured(req: NextRequest, pathname: string): NextResponse {
  if (isProtectedApi(pathname)) {
    return NextResponse.json(
      { ok: false, error: "Authentication misconfigured", code: "auth_misconfigured" },
      { status: 503 }
    );
  }
  const login = new URL("/login", req.url);
  login.searchParams.set("error", "auth_misconfigured");
  return NextResponse.redirect(login);
}

export async function middleware(req: NextRequest) {
  const provider = authProvider();
  if (provider === "supabase") return supabaseMiddleware(req);
  if (provider === null) {
    const { pathname } = req.nextUrl;
    if (isPublicPath(pathname)) return NextResponse.next();
    if (isProtectedPage(pathname) || isProtectedApi(pathname)) return misconfigured(req, pathname);
    return NextResponse.next();
  }
  return legacyMiddleware(req);
}

/**
 * AUTH_PROVIDER=supabase (spec §5.1): per-request server client, getClaims() first (verifies the JWT
 * signature and expiry and refreshes the session), then the same 307-to-login / 401-JSON behaviour.
 * The legacy fna_session cookie is never read in this mode.
 */
async function supabaseMiddleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const sessionOnly = SESSION_ONLY_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!sessionOnly && !isProtectedPage(pathname) && !isProtectedApi(pathname)) return NextResponse.next();

  const config = supabaseAuthConfig();
  if (!config) return misconfigured(req, pathname);

  let response = NextResponse.next({ request: req });
  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll(list, headers) {
        for (const { name, value } of list) req.cookies.set(name, value);
        response = NextResponse.next({ request: req });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });
  const { data, error } = await supabase.auth.getClaims();
  const signedIn = !error && Boolean(data?.claims?.sub);

  const carry = (res: NextResponse): NextResponse => {
    for (const c of response.cookies.getAll()) res.cookies.set(c);
    for (const h of ["cache-control", "expires", "pragma"]) {
      const v = response.headers.get(h);
      if (v) res.headers.set(h, v);
    }
    return res;
  };

  if (signedIn) {
    if (pathname === "/") return carry(NextResponse.redirect(new URL("/dashboard", req.url)));
    if (pathname === "/platform" || pathname.startsWith("/platform/")) return carry(await platformGate(req, supabase, pathname, response));
    if (sessionOnly || isProtectedApi(pathname)) return response;
    // Next renders a page in parallel with its layout, so a layout redirect alone can still stream
    // the page. Workspace access and §4.3 page permissions are decided here, before rendering;
    // the layout and page guards repeat the check.
    const ctxRes = await supabase.rpc("request_context");
    if (ctxRes.status === 401 || ctxRes.status === 403) return carry(loginRedirect(req, pathname));
    if (ctxRes.error) {
      return carry(new NextResponse("Service temporarily unavailable", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
      }));
    }
    const ctx = contextFromRpc(ctxRes.data, data!.claims as Record<string, unknown>);
    const denial = evaluateContext(ctx, { permission: pagePermission(pathname) });
    if (denial === "unauthenticated") return carry(loginRedirect(req, pathname));
    if (denial) return carry(NextResponse.redirect(new URL(denialRedirect(denial, ctx), req.url)));
    return response;
  }
  if (isProtectedApi(pathname)) {
    return carry(NextResponse.json({ ok: false, error: "Unauthorized", code: "unauthenticated" }, { status: 401 }));
  }
  return carry(loginRedirect(req, pathname));
}

/**
 * Platform console pages (§7.5), decided before rendering: an AAL2 platform admin passes (and is sent
 * on from /platform/mfa); a listed admin with an AAL1 session is sent to /platform/mfa; anyone else
 * gets the ordinary 404 page, so the console is not advertised. The pages and APIs repeat the check.
 */
async function platformGate(
  req: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
  pathname: string,
  next: NextResponse
): Promise<NextResponse> {
  const unavailable = () => new NextResponse("Service temporarily unavailable", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
  const res = await supabase.rpc("platform_status");
  if (res.status === 401 || res.status === 403) return loginRedirect(req, pathname);
  if (res.error) return unavailable();
  const status = (res.data ?? {}) as { listed?: boolean; active?: boolean };
  const mfaPage = pathname === "/platform/mfa";
  if (status.active === true) return mfaPage ? NextResponse.redirect(new URL("/platform", req.url)) : next;
  if (status.listed === true) return mfaPage ? next : NextResponse.redirect(new URL("/platform/mfa", req.url));
  return NextResponse.rewrite(new URL("/_platform-not-found", req.url), { status: 404 });
}

async function legacyMiddleware(req: NextRequest) {
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
    "/api/tenant/config",
    "/api/workspaces/:path*",
    "/api/platform/:path*",
    "/api/team/:path*",
    "/api/settings/:path*",
    "/api/integrations/:path*",
    "/api/audit/:path*",
    "/api/onboarding/checklist",
    "/api/contacts/:path*",
    "/api/pipeline/:path*",
    "/api/opportunities/:path*",
    "/api/calendars/:path*",
    "/api/appointments/:path*",
    "/api/conversations/:path*",
    "/api/tasks/:path*",
    "/api/reviews/:path*",
    "/api/reports/:path*",
    "/no-access",
    "/workspace-suspended",
    "/platform",
    "/platform/:path*",
  ],
};

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
import type { AuthRole, SessionPayload } from "./types";
import { roleSatisfies } from "./types";

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

/**
 * Page role gate. Unauthenticated users go to login.
 * Authenticated users below `minimum` are redirected to the dashboard (no /admin).
 */
export async function requirePageRole(minimum: AuthRole): Promise<SessionPayload | null> {
  const secret = getAuthSecret();
  if (!secret) {
    if (mustProtectRoutes()) redirect("/login?error=auth_misconfigured");
    return null;
  }

  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const session = token ? await verifySessionToken(token, secret) : null;
  if (!session) redirect("/login");
  if (!roleSatisfies(session.role, minimum)) {
    redirect("/dashboard?denied=1");
  }
  return session;
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

/**
 * API session + role gate.
 * Returns a 401/503 NextResponse when auth fails, 403 when role is insufficient,
 * or the session when authorized. When auth is not enforced (open local), returns null session.
 */
export async function requireApiRole(
  req: NextRequest,
  minimum: AuthRole
): Promise<{ session: SessionPayload | null; error: NextResponse | null }> {
  const secret = getAuthSecret();
  if (!secret) {
    if (mustProtectRoutes()) {
      return {
        session: null,
        error: NextResponse.json(
          { ok: false, error: "Authentication misconfigured" },
          { status: 503 }
        ),
      };
    }
    return { session: null, error: null };
  }

  const session = await readSessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return {
      session: null,
      error: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!roleSatisfies(session.role, minimum)) {
    return {
      session,
      error: NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 }),
    };
  }
  return { session, error: null };
}

/** Resolve the current API session without enforcing (for conditional payloads). */
export async function getApiSession(
  req: NextRequest
): Promise<SessionPayload | null> {
  const secret = getAuthSecret();
  if (!secret) return null;
  return readSessionFromCookieHeader(req.headers.get("cookie"));
}

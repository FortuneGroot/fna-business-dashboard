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
import { authProvider } from "./provider";
import type { AuthRole, SessionPayload } from "./types";
import { roleSatisfies } from "./types";

function misconfiguredJson(): NextResponse {
  return NextResponse.json({ ok: false, error: "Authentication misconfigured" }, { status: 503 });
}

/** Final page authorization. Middleware is only an early signature/expiry filter. */
export async function requirePageSession(): Promise<void> {
  const provider = authProvider();
  if (provider === null) redirect("/login?error=auth_misconfigured");
  if (provider === "supabase") {
    const { requirePageContext } = await import("@/lib/authz/context");
    await requirePageContext();
    return;
  }

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
 * With AUTH_PROVIDER=supabase the gate is `permission` (spec §4.3) and the return value is null.
 */
export async function requirePageRole(
  minimum: AuthRole,
  permission?: string
): Promise<SessionPayload | null> {
  const provider = authProvider();
  if (provider === null) redirect("/login?error=auth_misconfigured");
  if (provider === "supabase") {
    const { requirePageContext, legacyRoleOf } = await import("@/lib/authz/context");
    const ctx = await requirePageContext({ permission });
    if (!permission) {
      const role = legacyRoleOf(ctx.role);
      if (!role || !roleSatisfies(role, minimum)) redirect("/dashboard?denied=1");
    }
    return null;
  }

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
  const provider = authProvider();
  if (provider === null) return misconfiguredJson();
  if (provider === "supabase") {
    const { requireApiContext } = await import("@/lib/authz/context");
    return (await requireApiContext(req)).error;
  }

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
 * With AUTH_PROVIDER=supabase the workspace role is mapped to the legacy role (§7.2).
 */
export async function requireApiRole(
  req: NextRequest,
  minimum: AuthRole
): Promise<{ session: SessionPayload | null; error: NextResponse | null }> {
  const provider = authProvider();
  if (provider === null) return { session: null, error: misconfiguredJson() };
  if (provider === "supabase") {
    const { requireApiContext, legacyRoleOf, denialResponse } = await import("@/lib/authz/context");
    const { ctx, error } = await requireApiContext(req);
    if (error) return { session: null, error };
    const session = sessionFromContext(ctx!, legacyRoleOf(ctx!.role));
    if (!session || !roleSatisfies(session.role, minimum)) {
      return { session, error: denialResponse("forbidden") };
    }
    return { session, error: null };
  }

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
  const provider = authProvider();
  if (provider === null) return null;
  if (provider === "supabase") {
    const { requireApiContext, legacyRoleOf } = await import("@/lib/authz/context");
    const { ctx, error } = await requireApiContext(req);
    return error || !ctx ? null : sessionFromContext(ctx, legacyRoleOf(ctx.role));
  }

  const secret = getAuthSecret();
  if (!secret) return null;
  return readSessionFromCookieHeader(req.headers.get("cookie"));
}

/** Legacy-shaped session for existing callers. Platform grant holders have no workspace role. */
function sessionFromContext(
  ctx: { email: string; name: string; userId: string },
  role: AuthRole | null
): SessionPayload | null {
  if (!role) return null;
  return { email: ctx.email, role, name: ctx.name, iat: 0, exp: 0, sid: ctx.userId };
}

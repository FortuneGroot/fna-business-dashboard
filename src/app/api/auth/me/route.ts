import { NextRequest, NextResponse } from "next/server";
import {
  isAuthEnforced,
  isAuthFailClosed,
  readSessionFromCookieHeader,
} from "@/lib/auth";
import { authProvider } from "@/lib/auth/provider";

export const dynamic = "force-dynamic";

/** AUTH_PROVIDER=supabase: §7.2 contract; signed-out callers get `user: null`. */
async function supabaseMe(req: NextRequest): Promise<NextResponse> {
  const { requireApiContext, legacyRoleOf } = await import("@/lib/authz/context");
  const { applyPendingCookies } = await import("@/lib/supabase/server");
  const { ctx, pending, error } = await requireApiContext(req, { allowNoWorkspace: true });
  // /api/auth/me is public in middleware, so a session refreshed here must reach the browser.
  const reply = (res: NextResponse) => applyPendingCookies(res, pending);
  if (error && error.status !== 401) {
    const body = await error.json();
    // Misconfigured or unavailable: the login page shows its "sign-in is not available" banner.
    return reply(NextResponse.json({ ...body, authEnforced: false, authFailClosed: true, user: null }, { status: error.status }));
  }
  const headers = { "Cache-Control": "private, no-store" };
  if (!ctx) {
    return reply(NextResponse.json(
      {
        ok: true,
        authEnforced: true,
        user: null,
        role: null,
        legacyRole: null,
        permissions: [],
        workspace: null,
        isPlatformAdmin: false,
        grant: null,
      },
      { headers }
    ));
  }
  return reply(NextResponse.json(
    {
      ok: true,
      authEnforced: true,
      user: { id: ctx.userId, email: ctx.email, name: ctx.name },
      role: ctx.role,
      legacyRole: legacyRoleOf(ctx.role),
      permissions: ctx.permissions,
      workspace: ctx.workspace,
      isPlatformAdmin: ctx.isPlatformAdmin,
      grant: ctx.grant ? { mode: ctx.grant.mode, expiresAt: ctx.grant.expiresAt } : null,
    },
    { headers }
  ));
}

export async function GET(req: NextRequest) {
  const provider = authProvider();
  if (provider === "supabase") return supabaseMe(req);
  if (provider === null) {
    return NextResponse.json(
      {
        ok: false,
        authEnforced: false,
        authFailClosed: true,
        user: null,
        message: "AUTH_PROVIDER has an unsupported value",
      },
      { status: 503 }
    );
  }
  if (!isAuthEnforced()) {
    if (isAuthFailClosed()) {
      return NextResponse.json(
        {
          ok: false,
          authEnforced: false,
          authFailClosed: true,
          user: null,
          message: "AUTH_SECRET required in this environment",
        },
        { status: 503 }
      );
    }
    return NextResponse.json({
      ok: true,
      authEnforced: false,
      authFailClosed: false,
      user: null,
      message: "AUTH_SECRET not set — auth not enforced on this deployment",
    });
  }
  const session = await readSessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, authEnforced: true, user: null }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    authEnforced: true,
    user: { email: session.email, role: session.role, name: session.name },
  });
}

import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  getAuthSecret,
  revokeSessionToken,
  sessionCookieOptions,
} from "@/lib/auth";
import { authProvider, supabaseAuthConfig } from "@/lib/auth/provider";
import { applyPendingCookies, supabaseForRequest } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** AUTH_PROVIDER=supabase: signOut({ scope: 'local' }) ends this session and clears its cookies. */
async function supabaseLogout(req: NextRequest): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Cache-Control", "private, no-store");
  const config = supabaseAuthConfig();
  if (!config) return res;
  const { supabase, pending } = supabaseForRequest(req.headers.get("cookie"), config);
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.error(
      "[auth/logout] Supabase sign-out failed",
      error instanceof Error ? error.message : "unknown error"
    );
  }
  applyPendingCookies(res, pending);
  // Clear every Supabase auth cookie even if the sign-out call failed.
  for (const c of req.cookies.getAll()) {
    if (/^sb-.+-auth-token(\.\d+)?$/.test(c.name) && !pending.cookies.some((p) => p.name === c.name)) {
      res.cookies.set(c.name, "", { path: "/", maxAge: 0 });
    }
  }
  return res;
}

export async function POST(req: NextRequest) {
  if (authProvider() === "supabase") return supabaseLogout(req);

  const secret = getAuthSecret();
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  const res = NextResponse.json({ ok: true, loggedOut: true });
  // Always clear the client cookie — even if durable revoke fails —
  // so a stale browser cookie cannot remain "logged in" after logout.
  res.cookies.set(AUTH_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  try {
    if (secret && cookie) {
      await revokeSessionToken(cookie, secret);
    }
  } catch (error) {
    console.error(
      "[auth/logout] durable session revoke failed",
      error instanceof Error ? error.message : "unknown error"
    );
  }
  return res;
}

import { NextRequest, NextResponse } from "next/server";
import { isAuthEnforced, readSessionFromCookieHeader } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAuthEnforced()) {
    return NextResponse.json({
      ok: true,
      authEnforced: false,
      user: null,
      message: "AUTH_SECRET not set — auth not enforced on this deployment",
    });
  }
  const session = readSessionFromCookieHeader(req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ ok: false, authEnforced: true, user: null }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    authEnforced: true,
    user: { email: session.email, role: session.role, name: session.name },
  });
}

import { NextRequest, NextResponse } from "next/server";
import {
  isAuthEnforced,
  isAuthFailClosed,
  readSessionFromCookieHeader,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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

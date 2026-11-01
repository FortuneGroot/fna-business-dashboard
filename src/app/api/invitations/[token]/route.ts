import { NextResponse, type NextRequest } from "next/server";
import { ApiError, errorResponse, notFound } from "@/lib/api/native";
import { authProvider, supabaseAuthConfig } from "@/lib/auth/provider";
import { misconfiguredResponse } from "@/lib/authz/context";
import { peekInvitation } from "@/lib/native/invitations";
import { supabaseAnonymous } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

/** Public invitation preview: `{ workspaceName, role, emailMasked, accountExists }`, 404, or 410. */
export async function GET(_req: NextRequest, { params }: Params) {
  if (authProvider() !== "supabase") return errorResponse(notFound());
  const config = supabaseAuthConfig();
  if (!config) return misconfiguredResponse();
  const { token } = await params;
  try {
    const preview = await peekInvitation(supabaseAnonymous(config), token);
    return NextResponse.json({ ok: true, ...preview }, { headers: HEADERS });
  } catch (err) {
    if (err instanceof ApiError) {
      const res = errorResponse(err);
      res.headers.set("Referrer-Policy", "no-referrer");
      return res;
    }
    throw err;
  }
}

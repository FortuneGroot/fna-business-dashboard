import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, dbFailure, errorResponse, notFound, parseBody } from "@/lib/api/native";
import { authProvider, supabaseAuthConfig } from "@/lib/auth/provider";
import { misconfiguredResponse } from "@/lib/authz/context";
import { INVITATION_TOKEN } from "@/lib/native/invitations";
import { createUserFromInvitation } from "@/lib/supabase/admin";
import { applyPendingCookies, supabaseForRequest } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

const body = z.strictObject({
  password: z
    .string()
    .min(12, "Use at least 12 characters")
    .max(72, "Use at most 72 characters")
    .optional(),
});

function signupFailure(code: Exclude<Awaited<ReturnType<typeof createUserFromInvitation>>, { ok: true }>["code"]): ApiError {
  if (code === "conflict") {
    return new ApiError(409, "account_exists", "An account already exists for this email. Sign in to accept the invitation.");
  }
  if (code === "weak_password") {
    return new ApiError(422, "validation_failed", "Choose a stronger password", { password: "Choose a stronger password" });
  }
  if (code === "unavailable") return new ApiError(503, "unavailable", "Service temporarily unavailable");
  return dbFailure({ message: code });
}

/**
 * Accepts an invitation. Signed in: rpc accept_invitation with the caller's JWT (the invitation's
 * email must match). Not signed in: `{ password }` creates the invited address's account (A1; the
 * email comes from the invitation), signs it in, and accepts with the new user's own JWT.
 */
export async function POST(req: NextRequest, { params }: Params) {
  if (authProvider() !== "supabase") return errorResponse(notFound());
  const config = supabaseAuthConfig();
  if (!config) return misconfiguredResponse();
  const { token } = await params;
  const { supabase, pending } = supabaseForRequest(req.headers.get("cookie"), config);
  const reply = (res: NextResponse) => {
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return applyPendingCookies(res, pending);
  };
  try {
    if (!INVITATION_TOKEN.test(token)) throw new ApiError(404, "invitation_not_found", "This invitation link is not valid.");
    const input = await parseBody(req, body);
    const { data: claims, error: claimsError } = await supabase.auth.getClaims();
    const signedIn = !claimsError && Boolean(claims?.claims?.sub);

    if (!signedIn) {
      if (!input.password) {
        throw new ApiError(401, "unauthenticated", "Sign in or choose a password to accept this invitation");
      }
      const created = await createUserFromInvitation(token, input.password);
      if (!created.ok) throw signupFailure(created.code);
      const signIn = await supabase.auth.signInWithPassword({ email: created.email, password: input.password });
      if (signIn.error || !signIn.data.session) throw new ApiError(503, "unavailable", "Your account was created. Sign in to finish joining.");
    }

    const res = await supabase.rpc("accept_invitation", { p_token: token });
    if (res.error) throw dbFailure(res.error);
    const workspace = (res.data as { workspace?: unknown } | null)?.workspace ?? null;
    return reply(NextResponse.json({ ok: true, workspace }));
  } catch (err) {
    if (err instanceof ApiError) return reply(errorResponse(err));
    throw err;
  }
}

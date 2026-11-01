import { NextRequest, NextResponse } from "next/server";
import { authProvider } from "@/lib/auth/provider";
import { requireApiContext, unavailableResponse } from "@/lib/authz/context";
import { applyPendingCookies } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Item = { id: string; name: string; slug: string; status: string; role: string | null; grant_mode: string | null };

/** Active memberships plus live platform grants for the signed-in user (§7.2). */
export async function GET(req: NextRequest) {
  if (authProvider() !== "supabase") {
    return NextResponse.json({ ok: false, error: "Not found", code: "not_found" }, { status: 404 });
  }
  const { supabase, pending, error } = await requireApiContext(req, { allowNoWorkspace: true });
  if (error) return error;
  const res = await supabase!.rpc("list_my_workspaces");
  if (res.error) return unavailableResponse();
  const workspaces = ((res.data as Item[] | null) ?? []).map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    status: w.status,
    role: w.role,
    grantMode: w.grant_mode,
  }));
  return applyPendingCookies(NextResponse.json({ ok: true, workspaces }), pending);
}

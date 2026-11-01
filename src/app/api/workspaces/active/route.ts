import { NextRequest, NextResponse } from "next/server";
import { authProvider } from "@/lib/auth/provider";
import { denialResponse, requireApiContext, unavailableResponse } from "@/lib/authz/context";
import { readJsonObject } from "@/lib/http/json-body";
import { applyPendingCookies } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Switches the active workspace through rpc switch_workspace (403 if not a member/grant, 423 if suspended). */
export async function POST(req: NextRequest) {
  if (authProvider() !== "supabase") {
    return NextResponse.json({ ok: false, error: "Not found", code: "not_found" }, { status: 404 });
  }
  const { supabase, pending, error } = await requireApiContext(req, { allowNoWorkspace: true });
  if (error) return error;
  const reply = (res: NextResponse) => applyPendingCookies(res, pending);

  const body = await readJsonObject(req);
  const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!UUID.test(workspaceId)) {
    return reply(NextResponse.json(
      { ok: false, error: "workspaceId must be a UUID", code: "validation_failed", fields: { workspaceId: "invalid" } },
      { status: 422 }
    ));
  }

  const res = await supabase!.rpc("switch_workspace", { p_workspace_id: workspaceId });
  if (res.error) {
    if (res.error.message === "workspace_suspended") return reply(denialResponse("workspace_suspended"));
    if (res.error.message === "forbidden" || res.error.code === "42501") return reply(denialResponse("forbidden"));
    return reply(unavailableResponse());
  }
  const workspace = (res.data as { workspace?: unknown } | null)?.workspace ?? null;
  return reply(NextResponse.json({ ok: true, workspace }));
}

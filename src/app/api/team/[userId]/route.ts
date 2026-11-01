import type { NextRequest } from "next/server";
import { forbidden, nativeApi, parseBody, parseId } from "@/lib/api/native";
import { memberPatch, removeMember, updateMember } from "@/lib/native/team";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ userId: string }> };

/** `{ role }` needs team.change_role; `{ overrides }` needs team.manage_overrides (§4.2). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { userId } = await params;
  return nativeApi(req, { permission: "team.read", sensitive: true }, async (scope) => {
    const id = parseId(userId, "userId");
    const patch = await parseBody(req, memberPatch);
    const needed = "role" in patch ? "team.change_role" : "team.manage_overrides";
    if (!scope.ctx.permissions.includes(needed)) throw forbidden();
    const member = await updateMember(scope, id, patch);
    return { member };
  });
}

/** Removing an owner or admin needs team.change_role, an employee team.remove (enforced by rpc remove_member). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { userId } = await params;
  return nativeApi(req, { permission: "team.read", sensitive: true }, async (scope) => {
    const id = parseId(userId, "userId");
    if (!scope.ctx.permissions.some((p) => p === "team.remove" || p === "team.change_role")) throw forbidden();
    await removeMember(scope, id);
    return {};
  });
}

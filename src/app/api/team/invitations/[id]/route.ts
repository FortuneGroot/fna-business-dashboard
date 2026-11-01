import type { NextRequest } from "next/server";
import { forbidden, nativeApi, parseId } from "@/lib/api/native";
import { revokeInvitation } from "@/lib/native/invitations";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Revokes a pending invitation; rpc revoke_invitation requires team.invite_<its role>. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return nativeApi(req, { permission: "team.read", sensitive: true }, async (scope) => {
    const invitationId = parseId(id);
    if (!scope.ctx.permissions.some((p) => p.startsWith("team.invite_"))) throw forbidden();
    await revokeInvitation(scope, invitationId);
    return {};
  });
}

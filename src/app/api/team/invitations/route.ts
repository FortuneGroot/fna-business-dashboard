import type { NextRequest } from "next/server";
import { appOrigin, forbidden, nativeApi, parseBody } from "@/lib/api/native";
import { createInvitation, invitationInput, listInvitations } from "@/lib/native/invitations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "team.read" }, async (scope) => {
    const items = await listInvitations(scope);
    return { items };
  });
}

/**
 * Creates an invitation and returns its link once. Nothing is sent: the inviter shares the link
 * themselves. Requires team.invite_<role>.
 */
export async function POST(req: NextRequest) {
  return nativeApi(req, { permission: "team.read", sensitive: true }, async (scope) => {
    const input = await parseBody(req, invitationInput);
    if (!scope.ctx.permissions.includes(`team.invite_${input.role}`)) throw forbidden();
    const { invitation, token } = await createInvitation(scope, input);
    return { invitation, inviteUrl: `${appOrigin(req)}/invite/${token}` };
  });
}

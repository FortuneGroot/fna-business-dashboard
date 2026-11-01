import "server-only";
import { z } from "zod";
import { ApiError, dbFailure } from "@/lib/api/native";
import { check, fromWorkspaceRows } from "./shared";
import type { DataScope } from "@/lib/data/query";
import { ROLES } from "./team";

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export type Invitation = {
  id: string;
  email: string;
  role: (typeof ROLES)[number];
  createdAt: string;
  expiresAt: string;
  status: InvitationStatus;
};

type RawInvitation = {
  id: string;
  email: string;
  role: Invitation["role"];
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

/** Raw invitation tokens are 64 lowercase hex characters (private.new_token). */
export const INVITATION_TOKEN = /^[0-9a-f]{64}$/;

export const invitationInput = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Enter a valid email address" })),
  role: z.enum(ROLES),
  ttlHours: z.number().int().min(1).max(168).optional(),
});

export function invitationStatus(raw: Pick<RawInvitation, "accepted_at" | "revoked_at" | "expires_at">, now = Date.now()): InvitationStatus {
  if (raw.revoked_at) return "revoked";
  if (raw.accepted_at) return "accepted";
  if (Date.parse(raw.expires_at) <= now) return "expired";
  return "pending";
}

function toInvitation(raw: RawInvitation): Invitation {
  return {
    id: raw.id,
    email: raw.email,
    role: raw.role,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    status: invitationStatus(raw),
  };
}

/** The 100 most recent invitations (token_hash is not selectable by clients). */
export async function listInvitations(scope: DataScope): Promise<Invitation[]> {
  const rows = await fromWorkspaceRows<RawInvitation>(
    scope,
    "workspace_invitations",
    "id, email, role, created_at, expires_at, accepted_at, revoked_at",
    (q) => q.order("created_at", { ascending: false }).order("id").limit(100)
  );
  return rows.map(toInvitation);
}

/**
 * rpc create_invitation (requires team.invite_<role>; rechecked after the workspace lock). The raw
 * token is returned to the caller once and never stored; nothing is emailed or texted.
 */
export async function createInvitation(
  scope: DataScope,
  input: z.infer<typeof invitationInput>
): Promise<{ invitation: Invitation; token: string }> {
  const data = check(
    await scope.supabase.rpc("create_invitation", {
      p_email: input.email,
      p_role: input.role,
      p_ttl_hours: input.ttlHours ?? 72,
    })
  ) as { invitation_id: string; token: string; expires_at: string };
  return {
    token: data.token,
    invitation: {
      id: data.invitation_id,
      email: input.email,
      role: input.role,
      createdAt: new Date().toISOString(),
      expiresAt: data.expires_at,
      status: "pending",
    },
  };
}

export type InvitationPreview = {
  workspaceName: string;
  role: Invitation["role"];
  emailMasked: string;
  accountExists: boolean;
};

/**
 * rpc peek_invitation (the only RPC open to anonymous callers): a valid invitation's workspace name,
 * role, masked email, and whether the address already has an account; otherwise 404/410.
 */
export async function peekInvitation(supabase: DataScope["supabase"], token: string): Promise<InvitationPreview> {
  if (!INVITATION_TOKEN.test(token)) throw new ApiError(404, "invitation_not_found", "This invitation link is not valid.");
  const data = check(await supabase.rpc("peek_invitation", { p_token: token })) as {
    status: "not_found" | "revoked" | "used" | "expired" | "valid";
    workspace_name?: string;
    role?: Invitation["role"];
    email_masked?: string;
    account_exists?: boolean;
  };
  if (data.status !== "valid") throw dbFailure({ message: `invitation_${data.status}` });
  return {
    workspaceName: data.workspace_name ?? "",
    role: data.role!,
    emailMasked: data.email_masked ?? "",
    accountExists: data.account_exists === true,
  };
}

export async function revokeInvitation(scope: DataScope, id: string): Promise<void> {
  check(await scope.supabase.rpc("revoke_invitation", { p_invitation_id: id }));
}

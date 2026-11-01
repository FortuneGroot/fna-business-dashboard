import "server-only";
import { z } from "zod";
import { check, notFound } from "@/lib/api/native";
import type { DataScope } from "@/lib/data/query";
import type { WorkspaceRole } from "@/lib/authz/evaluate";

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  status: "active" | "removed";
  joinedAt: string;
  overrides: Record<string, boolean>;
};

type RawMember = {
  user_id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  status: "active" | "removed";
  joined_at: string;
  overrides: Record<string, boolean> | null;
};

export const ROLES = ["owner", "admin", "employee"] as const;

/** Active members of the active workspace (rpc list_team_members, team.read). */
export async function listTeam(scope: DataScope): Promise<TeamMember[]> {
  const data = check(await scope.supabase.rpc("list_team_members"));
  return ((data as RawMember[] | null) ?? []).map((m) => ({
    userId: m.user_id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.status,
    joinedAt: m.joined_at,
    overrides: m.overrides ?? {},
  }));
}

const PERMISSION_KEY = z.string().regex(/^[a-z_]{2,40}\.[a-z_]{2,40}$/, "Unknown permission");

/** PATCH /api/team/[userId]: exactly one of a role change or a set of employee overrides (null clears). */
export const memberPatch = z.union([
  z.strictObject({ role: z.enum(ROLES) }),
  z.strictObject({
    overrides: z
      .record(PERMISSION_KEY, z.boolean().nullable())
      .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 64, "Provide 1 to 64 overrides"),
  }),
]);

/**
 * Role changes go through rpc set_member_role and overrides through rpc set_member_permissions
 * (atomic): both enforce §4.2 authority, self-change and last-owner rules after taking the
 * workspace lock, and write the audit log.
 */
export async function updateMember(scope: DataScope, userId: string, patch: z.infer<typeof memberPatch>): Promise<TeamMember> {
  if ("role" in patch) {
    check(await scope.supabase.rpc("set_member_role", { p_user_id: userId, p_role: patch.role }));
  } else {
    check(await scope.supabase.rpc("set_member_permissions", { p_user_id: userId, p_overrides: patch.overrides }));
  }
  const member = (await listTeam(scope)).find((m) => m.userId === userId);
  if (!member) throw notFound();
  return member;
}

export async function removeMember(scope: DataScope, userId: string): Promise<void> {
  check(await scope.supabase.rpc("remove_member", { p_user_id: userId }));
}

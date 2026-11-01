import type { AuthRole } from "@/lib/auth/types";

export type WorkspaceRole = "owner" | "admin" | "employee";
export type WorkspaceStatus = "active" | "suspended" | "archived";

/** Spec §5.1 / §6.3. Built only from the verified JWT and `rpc request_context`. */
export type RequestContext = {
  userId: string;
  email: string;
  name: string;
  workspace: { id: string; name: string; slug: string; status: WorkspaceStatus } | null;
  role: WorkspaceRole | null;
  permissions: string[];
  isPlatformAdmin: boolean;
  grant: { id: string; mode: "read" | "write"; expiresAt: string } | null;
};

export type ContextDenial = "unauthenticated" | "no_active_workspace" | "workspace_suspended" | "forbidden";

export type ContextRequirement = {
  permission?: string;
  /** Allow a signed-in user with no usable workspace (auth/me, workspace list and switching). */
  allowNoWorkspace?: boolean;
};

const LEGACY_ROLE: Record<WorkspaceRole, AuthRole> = { owner: "OWNER", admin: "ADMIN", employee: "CLIENT" };

/** owner→OWNER, admin→ADMIN, employee→CLIENT, so existing UI predicates keep working (§7.2). */
export function legacyRoleOf(role: WorkspaceRole | null): AuthRole | null {
  return role ? LEGACY_ROLE[role] : null;
}

type RawContext = {
  authenticated?: boolean;
  user_id?: string;
  is_platform_admin?: boolean;
  workspace?: { id: string; name: string; slug: string; status: WorkspaceStatus } | null;
  role?: WorkspaceRole | null;
  grant?: { id: string; mode: "read" | "write"; expires_at: string } | null;
  permissions?: string[];
};

/** Combines verified JWT claims with the `request_context` result; null unless both name the same user. */
export function contextFromRpc(raw: unknown, claims: Record<string, unknown>): RequestContext | null {
  const r = raw as RawContext | null;
  if (!r || r.authenticated !== true || !r.user_id || r.user_id !== claims.sub) return null;
  const email = String(claims.email ?? "");
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim() : email;
  return {
    userId: r.user_id,
    email,
    name,
    workspace: r.workspace ?? null,
    role: r.role ?? null,
    permissions: Array.isArray(r.permissions) ? r.permissions : [],
    isPlatformAdmin: r.is_platform_admin === true,
    grant: r.grant ? { id: r.grant.id, mode: r.grant.mode, expiresAt: r.grant.expires_at } : null,
  };
}

export function evaluateContext(ctx: RequestContext | null, req: ContextRequirement = {}): ContextDenial | null {
  if (!ctx) return "unauthenticated";
  if (req.allowNoWorkspace) return null;
  const ws = ctx.workspace;
  if (!ws || ws.status === "archived") return "no_active_workspace";
  // Suspended workspaces honour read grants only (§4.1); members are refused.
  if (ws.status === "suspended" && ctx.grant?.mode !== "read") return "workspace_suspended";
  if (!ctx.role && !ctx.grant) return "no_active_workspace";
  if (req.permission && !ctx.permissions.includes(req.permission)) return "forbidden";
  return null;
}

/** Where a page request goes for each denial (§7.1). */
export const PAGE_DENIAL_REDIRECT: Record<ContextDenial, string> = {
  unauthenticated: "/login",
  no_active_workspace: "/no-access",
  workspace_suspended: "/workspace-suspended",
  forbidden: "/dashboard?denied=1",
};

/** Page redirect for a denial; platform admins with no usable workspace go to the console (§5.1). */
export function denialRedirect(denial: ContextDenial, ctx: RequestContext | null): string {
  if (denial === "no_active_workspace" && ctx?.isPlatformAdmin) return "/platform";
  return PAGE_DENIAL_REDIRECT[denial];
}

/** Pages gated by a permission rather than membership alone (§4.3). */
export const PAGE_PERMISSIONS: Record<string, string> = {
  "/onboarding": "onboarding.read",
  "/library": "library.read",
};

export function pagePermission(pathname: string): string | undefined {
  for (const [prefix, permission] of Object.entries(PAGE_PERMISSIONS)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return permission;
  }
  return undefined;
}

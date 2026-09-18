export type AuthRole = "OWNER" | "ADMIN" | "CLIENT";

export type SessionUser = {
  email: string;
  role: AuthRole;
  name: string;
};

export type SessionPayload = SessionUser & {
  exp: number;
  iat: number;
  sid?: string;
};

export const AUTH_COOKIE = "fna_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

/** Higher rank = more privilege. OWNER > ADMIN > CLIENT. */
const ROLE_RANK: Record<AuthRole, number> = {
  CLIENT: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function isAuthRole(value: string): value is AuthRole {
  return value === "OWNER" || value === "ADMIN" || value === "CLIENT";
}

/** V1: one client per deployment — all roles may access this deployment's dashboard. */
export function roleAllowsDashboard(role: AuthRole): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "CLIENT";
}

export function roleRank(role: AuthRole): number {
  return ROLE_RANK[role] ?? 0;
}

/** True when `role` meets or exceeds the minimum required role. */
export function roleSatisfies(role: AuthRole, minimum: AuthRole): boolean {
  return roleRank(role) >= roleRank(minimum);
}

/** Library / Resources — ADMIN and OWNER. */
export function canAccessLibrary(role: AuthRole): boolean {
  return roleSatisfies(role, "ADMIN");
}

/** Settings Integrations + owner configuration — OWNER only. */
export function canAccessOwnerSettings(role: AuthRole): boolean {
  return roleSatisfies(role, "OWNER");
}

/** Sync health diagnostics — ADMIN and OWNER. */
export function canAccessSyncHealth(role: AuthRole): boolean {
  return roleSatisfies(role, "ADMIN");
}

/** Event audit + onboarding readiness — OWNER only. */
export function canAccessOwnerApis(role: AuthRole): boolean {
  return roleSatisfies(role, "OWNER");
}

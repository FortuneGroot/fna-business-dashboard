export type AuthRole = "OWNER" | "ADMIN" | "CLIENT";

export type SessionUser = {
  email: string;
  role: AuthRole;
  name: string;
};

export type SessionPayload = SessionUser & {
  exp: number;
  iat: number;
};

export const AUTH_COOKIE = "fna_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

export function isAuthRole(value: string): value is AuthRole {
  return value === "OWNER" || value === "ADMIN" || value === "CLIENT";
}

/** V1: one client per deployment — all roles may access this deployment's dashboard. */
export function roleAllowsDashboard(role: AuthRole): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "CLIENT";
}

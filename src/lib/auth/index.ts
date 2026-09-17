export { AUTH_COOKIE, SESSION_TTL_SECONDS, isAuthRole, roleAllowsDashboard } from "./types";
export type { AuthRole, SessionPayload, SessionUser } from "./types";
export {
  authenticateCredentials,
  createSessionToken,
  getAuthSecret,
  isAuthEnforced,
  readSessionFromCookieHeader,
  sessionCookieOptions,
  verifySessionToken,
} from "./session";

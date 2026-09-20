export {
  AUTH_COOKIE,
  SESSION_TTL_SECONDS,
  isAuthRole,
  roleAllowsDashboard,
  roleRank,
  roleSatisfies,
  canAccessLibrary,
  canAccessOwnerSettings,
  canAccessSyncHealth,
  canAccessOwnerApis,
} from "./types";
export type { AuthRole, SessionPayload, SessionUser } from "./types";
export {
  authenticateCredentials,
  createSessionToken,
  getAuthSecret,
  isAuthEnforced,
  isAuthFailClosed,
  mustProtectRoutes,
  readSessionFromCookieHeader,
  revokeSessionToken,
  sessionCookieOptions,
  verifySessionToken,
} from "./session";
export type { RevokeSessionResult } from "./session";
export { safeNextPath } from "./safe-next";
export { interpretAuthMeProbe } from "./auth-me-probe";
export type { AuthMeProbeBody, AuthMeProbeResult } from "./auth-me-probe";
export { passwordsMatch, consumeLoginAttempt, resetLoginRateLimitForTests } from "./password";
export {
  createStoredSession,
  getStoredSession,
  revokeStoredSession,
  resetAuthSessionsForTests,
  allowMemorySessionFallback,
  createSessionId,
} from "./session-store";
export {
  requireApiSession,
  requireApiRole,
  requirePageSession,
  requirePageRole,
  getApiSession,
} from "./guards";

export { AUTH_COOKIE, SESSION_TTL_SECONDS, isAuthRole, roleAllowsDashboard } from "./types";
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
export { safeNextPath } from "./safe-next";
export { passwordsMatch, consumeLoginAttempt, resetLoginRateLimitForTests } from "./password";
export {
  createStoredSession,
  getStoredSession,
  revokeStoredSession,
  resetAuthSessionsForTests,
  allowMemorySessionFallback,
  createSessionId,
} from "./session-store";
export { requireApiSession, requirePageSession } from "./guards";

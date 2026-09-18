/**
 * Shared interpretation of GET /api/auth/me for the login page.
 * Evaluated only at request runtime (client fetch) — never build-time.
 */

export type AuthMeProbeBody = {
  authEnforced?: boolean;
  authFailClosed?: boolean;
  user?: unknown;
  ok?: boolean;
  error?: string;
  message?: string;
};

export type AuthMeProbeResult = {
  /** True when the deployment requires credentials to use protected surfaces. */
  authReady: boolean;
  /** True when Production/fail-closed is missing AUTH_SECRET. */
  misconfigured: boolean;
  message: string;
};

/**
 * Map /api/auth/me HTTP status + JSON into login UI state.
 * - authEnforced true → ready
 * - HTTP 401 (session required) → ready (auth is on)
 * - authFailClosed without authEnforced → misconfigured
 * - 200 with authEnforced false → not enforced (Preview/local open)
 */
export function interpretAuthMeProbe(
  status: number,
  data: AuthMeProbeBody
): AuthMeProbeResult {
  const misconfigured = Boolean(data.authFailClosed && data.authEnforced !== true);
  const authReady =
    data.authEnforced === true || (status === 401 && data.authEnforced !== false);
  let message = "";
  if (misconfigured) {
    message = "Authentication is required but AUTH_SECRET is not configured.";
  } else if (!authReady) {
    message =
      "Authentication is not enforced on this deployment yet. Set AUTH_SECRET and owner credentials in the environment to enable login.";
  }
  return { authReady, misconfigured, message };
}

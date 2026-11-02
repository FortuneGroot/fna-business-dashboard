import assert from "node:assert/strict";

/** Reject outages, routing failures and malformed responses as evidence of token revocation. */
export async function assertAuthRejected(response: Response, kind: "access" | "refresh"): Promise<void> {
  const statuses = kind === "refresh" ? [400, 401, 403] : [401, 403];
  assert.ok(statuses.includes(response.status), `expected an Auth rejection, received HTTP ${response.status}`);
  const value: unknown = await response.json();
  assert.ok(value && typeof value === "object", "Auth rejection must have an error code");
  const body = value as Record<string, unknown>;
  // GoTrue's raw HTTP response may use numeric `code` plus string `error_code`.
  const code = typeof body.error_code === "string" ? body.error_code : body.code;
  const codes = kind === "refresh"
    ? ["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired"]
    : ["session_not_found", "session_expired", "bad_jwt", "user_not_found"];
  const diagnostic = typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "missing-or-invalid";
  assert.ok(typeof code === "string" && codes.includes(code), `unexpected Auth rejection code: ${diagnostic}`);
}

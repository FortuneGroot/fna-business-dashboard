/**
 * Supabase PostgREST auth headers for SUPABASE_SERVICE_ROLE_KEY.
 * Never log or return the raw key from callers beyond header maps used for fetch.
 *
 * - Legacy JWT service_role keys (`eyJ…`): apikey + Authorization: Bearer
 * - New secret keys (`sb_secret_…` and any non-JWT key): apikey only
 */

export function isLegacyJwtServiceRoleKey(key: string): boolean {
  return key.trim().startsWith("eyJ");
}

export function isSbSecretServiceRoleKey(key: string): boolean {
  return key.trim().startsWith("sb_secret_");
}

/**
 * Headers for manual Supabase REST calls.
 * Always sets `apikey`. Sets `Authorization: Bearer` only for legacy JWT keys.
 */
export function supabaseRestAuthHeaders(key: string): Record<string, string> {
  const k = String(key || "").trim();
  const headers: Record<string, string> = { apikey: k };
  if (isLegacyJwtServiceRoleKey(k)) {
    headers.Authorization = `Bearer ${k}`;
  }
  return headers;
}

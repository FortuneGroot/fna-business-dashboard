/**
 * Server-only privileged location / pipeline identifiers.
 * Importing this module from a Client Component will fail the build.
 */
import "server-only";

/** Hard-coded Master location — never overridable via env. */
export const PROTECTED_MASTER_LOCATION_ID = "NQwD3zdWCuBSVpOuzybj" as const;

/** F&A LIVE Preview location (server defaults only). */
export const FA_LIVE_LOCATION_ID = "kIXDnRuhkj6HLR1g6V6V" as const;

/** F&A LIVE default pipeline UUID (server defaults only). */
export const FA_LIVE_PIPELINE_ID = "6XevPh4T3rX0qAYRfuta" as const;

/** @deprecated Prefer PROTECTED_MASTER_LOCATION_ID — kept for readiness exports. */
export const FORBIDDEN_MASTER_LOCATION_ID = PROTECTED_MASTER_LOCATION_ID;

export function isProtectedMasterLocationId(id: string | null | undefined): boolean {
  return Boolean(id && id.trim() === PROTECTED_MASTER_LOCATION_ID);
}

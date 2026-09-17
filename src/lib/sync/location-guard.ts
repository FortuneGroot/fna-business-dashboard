import { BRAND } from "@/lib/brand";
import { loadEnv } from "@/lib/env";
import { PROTECTED_MASTER_LOCATION_ID, configuredLocationId } from "@/lib/tenant";

/**
 * Reject Master always. Allow only the configured client location for this deployment.
 * Master block is absolute — not overridable by env.
 */
export function assertAllowedLocationId(locationId: string): string {
  const env = loadEnv();
  const id = String(locationId || "").trim();
  if (!id) throw new Error("location_id required");
  if (
    id === PROTECTED_MASTER_LOCATION_ID ||
    id === BRAND.forbiddenMasterId ||
    id === env.forbiddenMasterId
  ) {
    throw new Error("Protected Master location refused");
  }
  const configured = configuredLocationId();
  if (id !== configured || id !== env.locationId) {
    throw new Error("Location not allowed for this dashboard");
  }
  return id;
}

export function deploymentLocationId(): string {
  return assertAllowedLocationId(loadEnv().locationId);
}

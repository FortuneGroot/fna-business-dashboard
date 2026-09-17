import { BRAND } from "@/lib/brand";
import { loadEnv } from "@/lib/env";

/** Reject Master and non-live location IDs for every sync data-plane operation. */
export function assertAllowedLocationId(locationId: string): string {
  const env = loadEnv();
  const id = String(locationId || "").trim();
  if (!id) throw new Error("location_id required");
  if (id === BRAND.forbiddenMasterId || id === env.forbiddenMasterId) {
    throw new Error("Protected Master location refused");
  }
  if (id !== BRAND.liveLocationId || id !== env.locationId) {
    throw new Error("Location not allowed for this dashboard");
  }
  return id;
}

export function deploymentLocationId(): string {
  return assertAllowedLocationId(loadEnv().locationId);
}

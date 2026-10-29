import { loadEnv, validateEnv } from "./env";
import { logEvent } from "./logging";
import { PROTECTED_MASTER_LOCATION_ID, configuredLocationId, clientBusinessName } from "./tenant";

const SERVICES = "https://services.leadconnectorhq.com";

export class GhlRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhlRefusedError";
  }
}

/** Assert location is the configured client location and never Master. */
export function assertConfiguredLocation(locationId: string): void {
  const env = loadEnv();
  if (
    locationId === PROTECTED_MASTER_LOCATION_ID ||
    locationId === env.forbiddenMasterId
  ) {
    throw new GhlRefusedError("Refused: protected Master location.");
  }
  const configured = configuredLocationId();
  if (locationId !== configured || locationId !== env.locationId) {
    throw new GhlRefusedError(
      `Refused: location ${locationId} is not the configured client location (${configured}).`
    );
  }
}

/** @deprecated Use assertConfiguredLocation */
export function assertLiveLocation(locationId: string): void {
  assertConfiguredLocation(locationId);
}

export type GhlHealth = {
  connected: boolean;
  mode: "dry-run" | "live-read" | "unconfigured";
  locationId: string;
  httpStatus: number | null;
  locationName: string | null;
  matchesConfigured: boolean;
  /** @deprecated use matchesConfigured */
  matchesLive: boolean;
  looksLikeMaster: boolean;
  error: string | null;
};

export async function checkGhlConnection(): Promise<GhlHealth> {
  const env = loadEnv();
  const envErrors = validateEnv(env);
  if (envErrors.length) {
    return {
      connected: false,
      mode: "unconfigured",
      locationId: env.locationId,
      httpStatus: null,
      locationName: null,
      matchesConfigured: false,
      matchesLive: false,
      looksLikeMaster: env.locationId === PROTECTED_MASTER_LOCATION_ID,
      error: envErrors.join(" "),
    };
  }

  if (!env.tokenPresent) {
    return {
      connected: false,
      mode: "unconfigured",
      locationId: env.locationId,
      httpStatus: null,
      locationName: null,
      matchesConfigured: env.locationId === configuredLocationId(),
      matchesLive: env.locationId === configuredLocationId(),
      looksLikeMaster: false,
      error: "GHL_API_TOKEN is empty. PIT not configured. No request sent.",
    };
  }

  assertConfiguredLocation(env.locationId);
  const token = (process.env.GHL_API_TOKEN || "").trim();
  const targetLocation = configuredLocationId();
  const res = await fetch(`${SERVICES}/locations/${targetLocation}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const loc =
    body.location && typeof body.location === "object"
      ? (body.location as Record<string, unknown>)
      : body;
  const id = String(loc.id || "");
  const name = String(loc.name || "");
  const looksLikeMaster =
    id === PROTECTED_MASTER_LOCATION_ID ||
    name.toLowerCase().includes("master") ||
    name.toLowerCase().includes("do not use live");
  const expectedName = clientBusinessName().toLowerCase();
  const matchesConfigured =
    id === targetLocation &&
    (expectedName.length < 3 || name.toLowerCase().includes(expectedName.split(" ")[0] || ""));

  logEvent("ghl.health", {
    httpStatus: res.status,
    matchesConfigured,
    looksLikeMaster,
    namePresent: Boolean(name),
  });

  if (looksLikeMaster || id === PROTECTED_MASTER_LOCATION_ID) {
    throw new GhlRefusedError("Health check returned protected Master. Aborting.");
  }

  return {
    connected: res.ok && id === targetLocation,
    mode: "live-read",
    locationId: id || env.locationId,
    httpStatus: res.status,
    locationName: name || null,
    matchesConfigured: id === targetLocation,
    matchesLive: id === targetLocation,
    looksLikeMaster,
    error: res.ok ? null : String(body.message || body.error || `HTTP ${res.status}`),
  };
}

export async function createContactDryRunOnly(): Promise<never> {
  throw new GhlRefusedError(
    "Production contact writes are disabled. Set ALLOW_PRODUCTION_CONTACT_WRITES after a separate authorization. Default is dry-run."
  );
}

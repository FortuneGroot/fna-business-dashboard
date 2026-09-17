import { BRAND } from "./brand";
import { loadEnv, validateEnv } from "./env";
import { logEvent } from "./logging";

const SERVICES = "https://services.leadconnectorhq.com";

export class GhlRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhlRefusedError";
  }
}

export function assertLiveLocation(locationId: string): void {
  const env = loadEnv();
  if (locationId === env.forbiddenMasterId || locationId === BRAND.forbiddenMasterId) {
    throw new GhlRefusedError("Refused: protected Master location.");
  }
  if (locationId !== BRAND.liveLocationId) {
    throw new GhlRefusedError(`Refused: location ${locationId} is not LIVE Fortune & Automations.`);
  }
}

export type GhlHealth = {
  connected: boolean;
  mode: "dry-run" | "live-read" | "unconfigured";
  locationId: string;
  httpStatus: number | null;
  locationName: string | null;
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
      matchesLive: false,
      looksLikeMaster: env.locationId === env.forbiddenMasterId,
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
      matchesLive: env.locationId === BRAND.liveLocationId,
      looksLikeMaster: false,
      error: "GHL_API_TOKEN is empty. PIT not configured. No request sent.",
    };
  }

  assertLiveLocation(env.locationId);
  const token = (process.env.GHL_API_TOKEN || "").trim();
  const res = await fetch(`${SERVICES}/locations/${BRAND.liveLocationId}`, {
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
    name.toLowerCase().includes("master") || name.toLowerCase().includes("do not use live");
  const matchesLive =
    id === BRAND.liveLocationId &&
    name.toLowerCase().includes("fortune") &&
    name.toLowerCase().includes("automation");

  logEvent("ghl.health", {
    httpStatus: res.status,
    matchesLive,
    looksLikeMaster,
    namePresent: Boolean(name),
  });

  if (looksLikeMaster || id === BRAND.forbiddenMasterId) {
    throw new GhlRefusedError("Health check returned protected Master. Aborting.");
  }

  return {
    connected: res.ok && matchesLive,
    mode: "live-read",
    locationId: id || env.locationId,
    httpStatus: res.status,
    locationName: name || null,
    matchesLive,
    looksLikeMaster,
    error: res.ok ? null : String(body.message || body.error || `HTTP ${res.status}`),
  };
}

export async function createContactDryRunOnly(): Promise<never> {
  throw new GhlRefusedError(
    "Production contact writes are disabled. Set ALLOW_PRODUCTION_CONTACT_WRITES after a separate authorization. Default is dry-run."
  );
}

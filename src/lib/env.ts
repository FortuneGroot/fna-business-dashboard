import { BRAND } from "./brand";
import { OLD_PIPELINE_ID } from "./mapping";
import {
  PROTECTED_MASTER_LOCATION_ID,
  configuredLocationId,
  configuredPipelineId,
  getTenantConfig,
} from "./tenant";

export type AppEnv = {
  dryRun: boolean;
  allowProductionWrites: boolean;
  locationId: string;
  forbiddenMasterId: string;
  pipelineId: string;
  tokenPresent: boolean;
  webhookSecretPresent: boolean;
  fakeContactOnly: boolean;
};

export function loadEnv(): AppEnv {
  // Prefer explicit env, else tenant config (defaults to F&A LIVE).
  let locationId = (process.env.GHL_LOCATION_ID || "").trim();
  let pipelineId = (process.env.GHL_PIPELINE_ID || "").trim();
  try {
    if (!locationId) locationId = configuredLocationId();
    if (!pipelineId) pipelineId = configuredPipelineId();
  } catch {
    locationId = locationId || BRAND.liveLocationId;
    pipelineId = pipelineId || BRAND.pipelineId;
  }

  // Absolute Master id — never take "allowed master" from env override of the constant.
  const forbiddenMasterId = PROTECTED_MASTER_LOCATION_ID;

  return {
    dryRun: (process.env.GHL_DRY_RUN || "true").toLowerCase() !== "false",
    allowProductionWrites:
      (process.env.ALLOW_PRODUCTION_CONTACT_WRITES || "false").toLowerCase() === "true",
    locationId,
    forbiddenMasterId,
    pipelineId,
    tokenPresent: Boolean((process.env.GHL_API_TOKEN || "").trim()),
    webhookSecretPresent: Boolean((process.env.GHL_WEBHOOK_SECRET || "").trim()),
    fakeContactOnly: (process.env.FAKE_CONTACT_ONLY || "true").toLowerCase() !== "false",
  };
}

export function validateEnv(env: AppEnv): string[] {
  const errors: string[] = [];

  // Absolute Master block — not overridable by any env/config.
  if (
    env.locationId === PROTECTED_MASTER_LOCATION_ID ||
    env.locationId === env.forbiddenMasterId ||
    env.locationId === BRAND.forbiddenMasterId
  ) {
    errors.push("GHL_LOCATION_ID points at the protected Master. Refusing.");
  }

  let tenantLocation = "";
  let tenantPipeline = "";
  try {
    const tenant = getTenantConfig();
    tenantLocation = tenant.ghl.locationId.trim();
    tenantPipeline = tenant.ghl.pipelineId.trim();
    if (tenantLocation === PROTECTED_MASTER_LOCATION_ID) {
      errors.push("Client config locationId is the protected Master. Refusing.");
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "Tenant config failed to load.");
  }

  if (tenantLocation && env.locationId && env.locationId !== tenantLocation) {
    errors.push(
      `GHL_LOCATION_ID (${env.locationId}) must match configured client location (${tenantLocation}).`
    );
  }

  if (!env.locationId) {
    errors.push("GHL_LOCATION_ID / client locationId is missing.");
  }

  if (env.pipelineId === OLD_PIPELINE_ID) {
    errors.push("GHL_PIPELINE_ID is the retired pipeline. Remap to the client Sales Pipeline.");
  }

  if (tenantPipeline && env.pipelineId && env.pipelineId !== tenantPipeline) {
    errors.push(
      `GHL_PIPELINE_ID (${env.pipelineId}) must match configured client pipeline (${tenantPipeline}).`
    );
  }

  if (env.allowProductionWrites && env.dryRun) {
    errors.push("ALLOW_PRODUCTION_CONTACT_WRITES=true cannot be combined with GHL_DRY_RUN=true.");
  }
  return errors;
}

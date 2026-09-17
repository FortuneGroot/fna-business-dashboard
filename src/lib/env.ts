import { BRAND } from "./brand";
import { OLD_PIPELINE_ID } from "./mapping";

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
  const locationId = (process.env.GHL_LOCATION_ID || BRAND.liveLocationId).trim();
  const forbiddenMasterId = (
    process.env.FORBIDDEN_MASTER_LOCATION_ID || BRAND.forbiddenMasterId
  ).trim();
  return {
    dryRun: (process.env.GHL_DRY_RUN || "true").toLowerCase() !== "false",
    allowProductionWrites:
      (process.env.ALLOW_PRODUCTION_CONTACT_WRITES || "false").toLowerCase() === "true",
    locationId,
    forbiddenMasterId,
    pipelineId: (process.env.GHL_PIPELINE_ID || BRAND.pipelineId).trim(),
    tokenPresent: Boolean((process.env.GHL_API_TOKEN || "").trim()),
    webhookSecretPresent: Boolean((process.env.GHL_WEBHOOK_SECRET || "").trim()),
    fakeContactOnly: (process.env.FAKE_CONTACT_ONLY || "true").toLowerCase() !== "false",
  };
}

export function validateEnv(env: AppEnv): string[] {
  const errors: string[] = [];
  if (env.locationId === env.forbiddenMasterId) {
    errors.push("GHL_LOCATION_ID points at the protected Master. Refusing.");
  }
  if (env.locationId !== BRAND.liveLocationId) {
    errors.push(
      `GHL_LOCATION_ID must be LIVE ${BRAND.liveLocationId} (got ${env.locationId || "empty"}).`
    );
  }
  if (env.pipelineId === OLD_PIPELINE_ID) {
    errors.push("GHL_PIPELINE_ID is the retired pipeline. Use the LIVE Fortune & Automations Sales Pipeline.");
  }
  if (env.pipelineId !== BRAND.pipelineId) {
    errors.push(
      `GHL_PIPELINE_ID must be LIVE ${BRAND.pipelineId} (got ${env.pipelineId || "empty"}).`
    );
  }
  if (env.allowProductionWrites && env.dryRun) {
    errors.push("ALLOW_PRODUCTION_CONTACT_WRITES=true cannot be combined with GHL_DRY_RUN=true.");
  }
  return errors;
}

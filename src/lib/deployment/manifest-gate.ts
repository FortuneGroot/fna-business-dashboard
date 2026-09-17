import type { ClientConfig } from "@/lib/onboarding/types";
import { evaluateClientReadiness, looksLikePlaceholder } from "@/lib/onboarding";
import { PROTECTED_MASTER_LOCATION_ID } from "@/lib/tenant";

/** Reasons a config must not emit a deployment manifest. */
export function manifestBlockReasons(config: ClientConfig): string[] {
  const reasons: string[] = [];
  const loc = (config.ghl?.locationId || "").trim();
  const pipe = (config.ghl?.pipelineId || "").trim();

  if (!loc) reasons.push("locationId missing");
  if (loc === PROTECTED_MASTER_LOCATION_ID) reasons.push("protected Master locationId");
  if (looksLikePlaceholder(loc)) reasons.push("locationId is placeholder");
  if (!pipe || looksLikePlaceholder(pipe)) reasons.push("pipelineId missing or placeholder");

  const stages = Object.entries(config.ghl?.stageIds || {});
  if (!stages.length) reasons.push("required stages missing");
  if (stages.some(([, id]) => looksLikePlaceholder(id))) reasons.push("stage IDs contain placeholders");

  const cals = Object.entries(config.ghl?.calendarIds || {});
  if (!cals.length || looksLikePlaceholder(config.ghl?.bookingCalendarId)) {
    reasons.push("required calendars missing");
  }
  if (cals.some(([, id]) => looksLikePlaceholder(id))) {
    reasons.push("calendar IDs contain placeholders");
  }

  for (const [label, url] of [
    ["bookingUrl", config.ghl?.bookingUrl],
    ["reviewUrl", config.ghl?.reviewUrl],
    ["logoUrl", config.business?.logoUrl || config.branding?.logo],
    ["webhookDestination", config.sync?.webhookDestination],
  ] as const) {
    if (!url || looksLikePlaceholder(url) || /example\.invalid/i.test(String(url))) {
      reasons.push(`${label} missing, placeholder, or example.invalid`);
    }
  }

  const readiness = evaluateClientReadiness(config);
  if (readiness.status === "BLOCKED") {
    reasons.push(`readiness status BLOCKED`);
  }

  return [...new Set(reasons)];
}

export function assertCanGenerateManifest(config: ClientConfig): void {
  const reasons = manifestBlockReasons(config);
  if (reasons.length) {
    const err = new Error(`Refusing to generate manifest:\n- ${reasons.join("\n- ")}`);
    (err as Error & { reasons: string[] }).reasons = reasons;
    throw err;
  }
}

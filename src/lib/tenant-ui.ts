import {
  configuredCalendars,
  configuredPipelineName,
  configuredStageNames,
  getTenantConfig,
} from "@/lib/tenant";
import { looksLikePlaceholder } from "@/lib/onboarding";

export {
  configuredCalendars,
  configuredPipelineName,
  configuredStageNames,
};

export function looksLikePlaceholderStages(): boolean {
  const ids = Object.values(getTenantConfig().ghl.stageIds || {});
  if (!ids.length) return true;
  return ids.some((id) => looksLikePlaceholder(id));
}

export function looksLikePlaceholderCalendars(): boolean {
  const cfg = getTenantConfig();
  const ids = [
    cfg.ghl.bookingCalendarId,
    ...Object.values(cfg.ghl.calendarIds || {}),
  ];
  if (!ids.filter(Boolean).length) return true;
  return ids.some((id) => looksLikePlaceholder(id));
}

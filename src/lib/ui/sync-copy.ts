/**
 * Client-facing sync language for the Business Dashboard.
 * Never name HighLevel / GHL / LeadConnector in UI copy.
 */

export const SYNC_WAITING_TITLE = "Waiting for sync";

export function syncWaitingNote(entity = "data"): string {
  return `No ${entity} has arrived yet. Connected workflows send updates into this dashboard automatically. Figures stay blank until events arrive — nothing is invented here.`;
}

export function syncBannerWaiting(entity: string): string {
  return `Waiting for sync — no ${entity} yet.`;
}

export function syncBannerReady(detail: string): string {
  return detail;
}

export const SYNC_SOURCE_SHORT =
  "Figures come from connected workflow sync. Values stay at — until events arrive.";

export const SYNC_SOURCE_DETAIL =
  "Data on this page comes from connected workflow sync — not live CRM list APIs.";

export const SYNC_BANNER_ACTIVE =
  "Synced from connected workflows. Your CRM remains the source of record.";

export const PLACEHOLDER_CONFIG_STAGES =
  "Pipeline stages still need final setup before go-live. Contact Fortune & Automations if this persists.";

export const PLACEHOLDER_CONFIG_CALENDARS =
  "Calendar setup still needs final IDs before go-live. Contact Fortune & Automations if this persists.";

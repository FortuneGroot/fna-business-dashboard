/**
 * Client-facing sync language for the Business Dashboard.
 * Never name HighLevel / GHL / LeadConnector / Vercel / Supabase in UI copy.
 */

export const SYNC_WAITING_TITLE = "Waiting for sync";

export function syncWaitingNote(entity = "data"): string {
  return `Nothing received for ${entity} yet. Connected workflows send updates into this dashboard automatically. Figures stay blank until events arrive — nothing is invented here.`;
}

/** Short empty-column note (no repeated full paragraphs). */
export function syncColumnEmpty(): string {
  return "None yet";
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
  "Data on this page updates when your connected workflows send activity — it is not a live contact list.";

export const SYNC_BANNER_ACTIVE =
  "Synced from connected workflows. Your CRM remains the source of record.";

export const PLACEHOLDER_CONFIG_STAGES =
  "Pipeline stages still need final setup. Contact Fortune & Automations if this persists.";

export const PLACEHOLDER_CONFIG_CALENDARS =
  "Calendar setup still needs final configuration. Contact Fortune & Automations if this persists.";

/** Strip CRM merge tokens and technical markers from client-facing drafts. */
export function sanitizeClientFacingCopy(text: string): string {
  return String(text || "")
    .replace(/\[\[CV:([^\]]+)\]\]/gi, (_m, name: string) => `[${String(name).trim()}]`)
    .replace(/\[\[APPT:([^\]]+)\]\]/gi, (_m, name: string) => `[${String(name).trim()}]`)
    .replace(/\[\[LINK:([^\]]+)\]\]/gi, (_m, name: string) => `[${String(name).trim()}]`)
    .replace(/\[\[CONTACT:([^\]]+)\]\]/gi, (_m, name: string) => `[${String(name).trim()}]`)
    .replace(/\[\[CONTEXT:([^\]]+)\]\]/gi, (_m, name: string) => `[${String(name).trim()}]`)
    .replace(/\{\{CLIENT_BUSINESS_NAME\}\}/g, "[Business Name]")
    .replace(/\{\{[^}]+\}\}/g, "[value]");
}

export const CLIENT_FORBIDDEN_RENDER_TERMS = [
  "HighLevel",
  "GoHighLevel",
  "GHL",
  "$297",
  "/api/webhooks/ghl",
  "Vercel",
  "Supabase",
  "qa.lead@example.invalid",
  "Fortune&Finance",
  "[[CV:",
  "[[APPT:",
  "ClientConfig",
  "Next.js",
  "AUTH_SECRET",
  "Owner Command Center",
  "CRM list APIs",
  "vercel.app",
  "SUPABASE_SERVICE_ROLE",
  "GHL_WEBHOOK_SECRET",
  "NQwD3zdWCuBSVpOuzybj",
  "pit-",
] as const;

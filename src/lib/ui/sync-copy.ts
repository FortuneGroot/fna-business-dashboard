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

/**
 * Page copy by data source. `sync` is the legacy webhook-sync wording above, unchanged; `native` is
 * for workspaces reading their own records (AUTH_PROVIDER=supabase), with no sync or CRM language.
 */
export type DataCopy = {
  sourceShort: string;
  sourceDetail: string;
  bannerActive: string;
  bannerWaiting(entity: string): string;
  waitingTitle(entity: string): string;
  waitingNote(entity: string): string;
};

/** Legacy entity labels ("task events") read as record names in native copy ("tasks"). */
const NATIVE_NOUN: Record<string, string> = {
  metrics: "records",
  leads: "contacts",
  "task events": "tasks",
  "review events": "reviews",
  "conversation events": "conversations",
  "report data": "records",
};

export function nativeNoun(entity: string): string {
  return NATIVE_NOUN[entity] ?? entity;
}

export const SYNC_COPY: DataCopy = {
  sourceShort: SYNC_SOURCE_SHORT,
  sourceDetail: SYNC_SOURCE_DETAIL,
  bannerActive: SYNC_BANNER_ACTIVE,
  bannerWaiting: syncBannerWaiting,
  waitingTitle: () => SYNC_WAITING_TITLE,
  waitingNote: syncWaitingNote,
};

export const NATIVE_COPY: DataCopy = {
  sourceShort: "Figures come from this workspace's records. Values stay at — until records exist.",
  sourceDetail: "Data on this page comes from this workspace's own records.",
  bannerActive: "Showing this workspace's records.",
  bannerWaiting: (entity) => `No ${nativeNoun(entity)} yet.`,
  waitingTitle: (entity) => `No ${nativeNoun(entity)} yet`,
  waitingNote: (entity) => {
    const noun = nativeNoun(entity);
    const verb = noun.endsWith("s") ? "appear" : "appears";
    return `${noun.replace(/^./, (c) => c.toUpperCase())} added to this workspace ${verb} here. Nothing is invented here.`;
  },
};

export function dataCopy(native: boolean): DataCopy {
  return native ? NATIVE_COPY : SYNC_COPY;
}

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
  "pit-",
] as const;

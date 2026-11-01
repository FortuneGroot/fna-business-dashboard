import "server-only";
import { formatDuration, listCalendars } from "./calendars";
import { loadPipeline } from "./pipeline";
import { fromWorkspace, rows, type DataScope } from "./query";
import type { WorkspaceView } from "./types";

type SettingsRow = {
  business_name: string;
  legal_name: string;
  timezone: string;
  industry: string;
  support_email: string | null;
  business_phone: string | null;
  website_url: string | null;
  booking_url: string | null;
  review_url: string | null;
};

const SETTINGS_COLUMNS =
  "business_name, legal_name, timezone, industry, support_email, business_phone, website_url, booking_url, review_url";

/** The active workspace's settings, default pipeline, and calendars (spec §8.2 getWorkspaceConfig). */
export async function loadWorkspaceView(scope: DataScope): Promise<WorkspaceView> {
  const [[settings], pipeline, calendars] = await Promise.all([
    rows<SettingsRow>(fromWorkspace(scope, "workspace_settings", SETTINGS_COLUMNS).limit(1), "workspace_settings"),
    loadPipeline(scope),
    listCalendars(scope),
  ]);
  const businessName = settings?.business_name || scope.ctx.workspace?.name || "";
  return {
    businessName,
    legalName: settings?.legal_name || businessName,
    timezone: settings?.timezone || "America/New_York",
    industry: settings?.industry || "",
    supportEmail: settings?.support_email || "",
    phone: settings?.business_phone || "",
    website: settings?.website_url || "",
    bookingUrl: settings?.booking_url || "",
    reviewUrl: settings?.review_url || "",
    pipelineName: pipeline?.name || "Sales Pipeline",
    stageNames: pipeline?.stages.map((s) => s.name) ?? [],
    stages: pipeline?.stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind })) ?? [],
    stagesConfigured: Boolean(pipeline?.stages.length),
    calendars: calendars.map((c) => ({ id: c.id, name: c.name, duration: formatDuration(c.duration_minutes) })),
    calendarsConfigured: calendars.length > 0,
  };
}

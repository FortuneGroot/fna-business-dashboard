import "server-only";
import type { DataScope } from "@/lib/data/query";
import { countRows, fromWorkspaceRow } from "./shared";

export type ChecklistKey = "profile" | "team" | "calendar" | "ai_config";
export type ChecklistItem = { key: ChecklistKey; done: boolean };

/**
 * Native onboarding checklist (§7.4), computed from the workspace's own records with the caller's
 * JWT: contact details on the business profile, a second active member, a calendar, and an AI
 * receptionist greeting. Nothing is stored.
 */
export async function onboardingChecklist(scope: DataScope): Promise<ChecklistItem[]> {
  const [settings, members, calendars, ai] = await Promise.all([
    fromWorkspaceRow<{ support_email: string | null; business_phone: string | null }>(
      scope, "workspace_settings", "support_email, business_phone"
    ),
    countRows(scope, "workspace_members", (q) => q.eq("status", "active")),
    countRows(scope, "calendars", (q) => q.eq("active", true)),
    fromWorkspaceRow<{ greeting: string }>(scope, "ai_receptionist_configs", "greeting"),
  ]);
  return [
    { key: "profile", done: Boolean(settings?.support_email || settings?.business_phone) },
    { key: "team", done: members > 1 },
    { key: "calendar", done: calendars > 0 },
    { key: "ai_config", done: Boolean(ai?.greeting?.trim()) },
  ];
}

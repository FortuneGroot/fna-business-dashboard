import "server-only";
import { z } from "zod";
import { forbidden, notFound } from "@/lib/api/native";
import { activeWorkspaceId, type DataScope } from "@/lib/data/query";
import { check, fromWorkspaceRow } from "./shared";
import { uuid } from "@/lib/api/native";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezone = z.string().trim().min(1).max(64).refine(isTimeZone, "Unknown timezone");

const webUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && Boolean(u.hostname);
    } catch {
      return false;
    }
  }, "Enter a full http(s):// address");

const phone = z.string().trim().regex(/^\+?[0-9 ().-]{7,32}$/, "Enter a valid phone number");
const email = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Enter a valid email address" }));
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB color");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)");
const interval = z
  .strictObject({ start: hhmm, end: hhmm })
  .refine((i) => i.start < i.end, "Closing time must be after opening time");
const day = z.array(interval).max(4);

const nonEmpty = <T extends Record<string, unknown>>(o: T) => Object.keys(o).length > 0;

// ---------------------------------------------------------------------------
// Workspace settings
// ---------------------------------------------------------------------------

export type WorkspaceSettings = {
  businessName: string;
  legalName: string;
  timezone: string;
  industry: string;
  supportEmail: string | null;
  businessPhone: string | null;
  websiteUrl: string | null;
  bookingUrl: string | null;
  reviewUrl: string | null;
  brandColors: Record<string, string>;
  businessHours: Record<string, { start: string; end: string }[]>;
  hasLogo: boolean;
  updatedAt: string;
};

const SETTINGS_COLUMNS =
  "business_name, legal_name, timezone, industry, support_email, business_phone, website_url, booking_url, review_url, brand_colors, business_hours, logo_path, updated_at";

type RawSettings = {
  business_name: string;
  legal_name: string;
  timezone: string;
  industry: string;
  support_email: string | null;
  business_phone: string | null;
  website_url: string | null;
  booking_url: string | null;
  review_url: string | null;
  brand_colors: Record<string, string> | null;
  business_hours: Record<string, { start: string; end: string }[]> | null;
  logo_path: string | null;
  updated_at: string;
};

function toSettings(r: RawSettings): WorkspaceSettings {
  return {
    businessName: r.business_name,
    legalName: r.legal_name,
    timezone: r.timezone,
    industry: r.industry,
    supportEmail: r.support_email,
    businessPhone: r.business_phone,
    websiteUrl: r.website_url,
    bookingUrl: r.booking_url,
    reviewUrl: r.review_url,
    brandColors: r.brand_colors ?? {},
    businessHours: r.business_hours ?? {},
    hasLogo: Boolean(r.logo_path),
    updatedAt: r.updated_at,
  };
}

/** PATCH /api/settings/workspace. Logos change only through the Storage flow, never here. */
export const settingsPatch = z
  .strictObject({
    businessName: z.string().trim().min(1, "Business name is required").max(120),
    legalName: z.string().trim().max(160),
    timezone,
    industry: z.string().trim().max(80),
    supportEmail: email.nullable(),
    businessPhone: phone.nullable(),
    websiteUrl: webUrl.nullable(),
    bookingUrl: webUrl.nullable(),
    reviewUrl: webUrl.nullable(),
    brandColors: z.strictObject({ primary: hex.optional(), accent: hex.optional() }),
    businessHours: z.strictObject({
      mon: day.optional(), tue: day.optional(), wed: day.optional(), thu: day.optional(),
      fri: day.optional(), sat: day.optional(), sun: day.optional(),
    }),
  })
  .partial()
  .refine(nonEmpty, "Provide at least one field to change");

const SETTINGS_COLUMN: Record<keyof z.infer<typeof settingsPatch>, string> = {
  businessName: "business_name",
  legalName: "legal_name",
  timezone: "timezone",
  industry: "industry",
  supportEmail: "support_email",
  businessPhone: "business_phone",
  websiteUrl: "website_url",
  bookingUrl: "booking_url",
  reviewUrl: "review_url",
  brandColors: "brand_colors",
  businessHours: "business_hours",
};

export async function getWorkspaceSettings(scope: DataScope): Promise<WorkspaceSettings> {
  const row = await fromWorkspaceRow<RawSettings>(scope, "workspace_settings", SETTINGS_COLUMNS);
  if (!row) throw notFound();
  return toSettings(row);
}

/**
 * Updates through RLS with the caller's JWT (settings.write; column grants exclude attribution;
 * logo_path is set only by /api/settings/logo). The database stamps updated_by and records the change (M17).
 */
export async function updateWorkspaceSettings(
  scope: DataScope,
  patch: z.infer<typeof settingsPatch>
): Promise<WorkspaceSettings> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    values[SETTINGS_COLUMN[key as keyof typeof SETTINGS_COLUMN]] = value;
  }
  const data = check(
    await scope.supabase
      .from("workspace_settings")
      .update(values)
      .eq("workspace_id", activeWorkspaceId(scope))
      .select(SETTINGS_COLUMNS)
      .maybeSingle()
  );
  // RLS hides the row from an update the caller may not make.
  if (!data) throw forbidden();
  return toSettings(data as unknown as RawSettings);
}

// ---------------------------------------------------------------------------
// AI receptionist (configuration only; enablement stays blocked by the database)
// ---------------------------------------------------------------------------

export type AiReceptionistConfig = {
  enabled: false;
  runtimeAvailable: false;
  greeting: string;
  businessHoursMode: "always" | "business_hours" | "off";
  escalationUserId: string | null;
  faq: { question: string; answer: string }[];
  voice: string;
  updatedAt: string;
};

const AI_COLUMNS = "greeting, business_hours_mode, escalation_user_id, faq, voice, updated_at";

type RawAi = {
  greeting: string;
  business_hours_mode: AiReceptionistConfig["businessHoursMode"];
  escalation_user_id: string | null;
  faq: { question: string; answer: string }[] | null;
  voice: string;
  updated_at: string;
};

function toAi(r: RawAi): AiReceptionistConfig {
  return {
    enabled: false,
    runtimeAvailable: false,
    greeting: r.greeting,
    businessHoursMode: r.business_hours_mode,
    escalationUserId: r.escalation_user_id,
    faq: Array.isArray(r.faq) ? r.faq : [],
    voice: r.voice,
    updatedAt: r.updated_at,
  };
}

/** PUT /api/settings/ai-receptionist. No provider secrets; `enabled` may only restate false. */
export const aiPatch = z
  .strictObject({
    enabled: z.literal(false, { message: "The AI receptionist stays off until its runtime is available" }),
    greeting: z.string().trim().max(2000),
    businessHoursMode: z.enum(["always", "business_hours", "off"]),
    escalationUserId: uuid.nullable(),
    faq: z
      .array(z.strictObject({
        question: z.string().trim().min(1).max(300),
        answer: z.string().trim().min(1).max(2000),
      }))
      .max(50),
    voice: z.string().regex(/^[a-z0-9_-]{1,40}$/, "Unknown voice"),
  })
  .partial()
  .refine(nonEmpty, "Provide at least one field to change");

export async function getAiConfig(scope: DataScope): Promise<AiReceptionistConfig> {
  const row = await fromWorkspaceRow<RawAi>(scope, "ai_receptionist_configs", AI_COLUMNS);
  if (!row) throw notFound();
  return toAi(row);
}

/** The escalation target must be an active member of this workspace (composite FK + active-member trigger). */
export async function updateAiConfig(scope: DataScope, patch: z.infer<typeof aiPatch>): Promise<AiReceptionistConfig> {
  const values: Record<string, unknown> = {};
  if (patch.greeting !== undefined) values.greeting = patch.greeting;
  if (patch.businessHoursMode !== undefined) values.business_hours_mode = patch.businessHoursMode;
  if (patch.escalationUserId !== undefined) values.escalation_user_id = patch.escalationUserId?.toLowerCase() ?? null;
  if (patch.faq !== undefined) values.faq = patch.faq;
  if (patch.voice !== undefined) values.voice = patch.voice;
  if (!Object.keys(values).length) return getAiConfig(scope);
  const data = check(
    await scope.supabase
      .from("ai_receptionist_configs")
      .update(values)
      .eq("workspace_id", activeWorkspaceId(scope))
      .select(AI_COLUMNS)
      .maybeSingle()
  );
  if (!data) throw forbidden();
  return toAi(data as unknown as RawAi);
}

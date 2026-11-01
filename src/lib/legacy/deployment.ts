/**
 * The legacy single-deployment identity (AUTH_PROVIDER=legacy only; removed at T6 with the legacy tables).
 * It reproduces the values the pre-P7 build showed without a per-client configuration file: the F&A business, its
 * pipeline stages and calendars, and the partition key of the frozen `sync_*` snapshot.
 */
import "server-only";
import { BRAND } from "@/lib/brand";
import type { WorkspaceView } from "@/lib/data/types";

/** Partition the legacy snapshot was written under for F&A (the former GHL location id). */
export const LEGACY_DEFAULT_PARTITION = "kIXDnRuhkj6HLR1g6V6V" as const;

/** The protected Master location: never read, whatever the environment says. */
export const LEGACY_REFUSED_PARTITION = "NQwD3zdWCuBSVpOuzybj" as const;

/**
 * Partition of the legacy snapshot rows this deployment reads. GHL_LOCATION_ID is honoured only so a
 * legacy deployment that wrote under a different location keeps reading its own rows until T6.
 */
export function legacyPartition(env: NodeJS.ProcessEnv = process.env): string {
  const id = (env.GHL_LOCATION_ID || "").trim() || LEGACY_DEFAULT_PARTITION;
  if (id === LEGACY_REFUSED_PARTITION) throw new Error("Protected Master location refused");
  return id;
}

const STAGES = [
  "New Lead",
  "Attempting Contact",
  "Connected",
  "Qualified",
  "Appointment Booked",
  "Appointment Completed",
  "Estimate / Proposal Sent",
  "Follow-Up",
  "Decision Pending",
  "Won",
  "Lost",
  "Long-Term Nurture",
] as const;

const CALENDARS = [
  { name: "Discovery Call", duration: "30 min" },
  { name: "Website Consultation", duration: "30 min" },
  { name: "Business Consultation", duration: "30 min" },
  { name: "Client / Project Meeting", duration: "30 min" },
  { name: "Core Booking", duration: "1 hr" },
] as const;

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const LEGACY_BUSINESS = {
  businessName: BRAND.name,
  legalName: BRAND.legal,
  industry: "Automation / Websites / Branding / Systems",
  timezone: BRAND.timezone,
  phone: BRAND.supportPhoneRecovered,
  supportEmail: BRAND.supportEmailRecovered,
  website: BRAND.website,
  pipelineName: BRAND.pipelineName,
} as const;

export function legacyWorkspaceView(): WorkspaceView {
  return {
    businessName: LEGACY_BUSINESS.businessName,
    legalName: LEGACY_BUSINESS.legalName,
    timezone: LEGACY_BUSINESS.timezone,
    industry: LEGACY_BUSINESS.industry,
    supportEmail: LEGACY_BUSINESS.supportEmail,
    phone: LEGACY_BUSINESS.phone,
    website: LEGACY_BUSINESS.website,
    bookingUrl: "",
    reviewUrl: "",
    pipelineName: LEGACY_BUSINESS.pipelineName,
    stageNames: [...STAGES],
    stages: [],
    stagesConfigured: true,
    calendars: CALENDARS.map((c) => ({ id: `fa-live-cal-${slug(c.name)}`, name: c.name, duration: c.duration })),
    calendarsConfigured: true,
  };
}

/** Public login/chrome branding for the legacy deployment. */
export function legacyBranding() {
  return {
    businessName: LEGACY_BUSINESS.businessName,
    logoUrl: "",
    hasLogo: false,
    colors: { primary: BRAND.colors.blue, secondary: BRAND.colors.gold, background: BRAND.colors.cream },
  };
}

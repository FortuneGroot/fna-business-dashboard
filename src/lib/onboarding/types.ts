/**
 * Client configuration model for $297 HighLevel clone / onboarding.
 * No OAuth / $497 / Advanced API assumptions.
 */

export type ClientBusinessIdentity = {
  businessName: string;
  legalBusinessName: string;
  industry: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  timezone: string;
  businessPhone: string;
  supportEmail: string;
  leadNotificationEmail: string;
  websiteUrl: string;
  logoUrl: string;
};

export type ClientGhlConfig = {
  locationId: string;
  pipelineId: string;
  pipelineName: string;
  /** Stage name → HighLevel stage ID (client-specific after clone) */
  stageIds: Record<string, string>;
  bookingCalendarId: string;
  /** Calendar label → HighLevel calendar ID */
  calendarIds: Record<string, string>;
  bookingUrl: string;
  rescheduleUrl: string;
  reviewUrl: string;
  /** HighLevel user IDs mapped for assignment / staffing */
  assignedUserIds: string[];
  phoneNumber: string;
  domain: string;
};

export type ClientBranding = {
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  logo: string;
  favicon: string;
};

export type ClientChannels = {
  smsEnabled: boolean;
  emailEnabled: boolean;
  voiceEnabled: boolean;
  reviewEnabled: boolean;
  calendarEnabled: boolean;
};

export type ClientAiConfig = {
  conversationAiEnabled: boolean;
  voiceAiEnabled: boolean;
  aiBusinessName: string;
  aiGreeting: string;
  aiEscalationTarget: string;
};

export type ClientSyncConfig = {
  webhookDestination: string;
  /** Boolean only in API responses — never store/return the secret value here for public reads */
  webhookSecretConfigured: boolean;
  locationGuard: boolean;
  masterGuard: boolean;
};

export type ClientPaymentsConfig = {
  stripeConnected: boolean;
  paymentsEnabled: boolean;
};

export type ClientSafetyConfig = {
  /** Explicit known state: true | false. Omit/unknown is not READY. */
  allowProductionWrites?: boolean | null;
  dryRun?: boolean | null;
  fakeContactOnly?: boolean | null;
};

export type ClientConfig = {
  schemaVersion: "1.0";
  clientSlug: string;
  highlevelPlan: "$297 Unlimited";
  business: ClientBusinessIdentity;
  ghl: ClientGhlConfig;
  branding: ClientBranding;
  channels: ClientChannels;
  ai: ClientAiConfig;
  sync: ClientSyncConfig;
  payments: ClientPaymentsConfig;
  safety?: ClientSafetyConfig;
  /**
   * Anti-patterns that accidentally require $497 / OAuth / Advanced API.
   * Any true flag blocks readiness.
   */
  forbiddenDependencies?: {
    requiresAgencyPro497?: boolean;
    requiresAdvancedOAuth?: boolean;
    requiresAgencyCrmApi?: boolean;
    requiresWhiteLabelMobileAddon?: boolean;
  };
  /**
   * Optional remap notes. Never put live secrets here.
   * webhookSecretConfigured is the only secret-related flag allowed in readiness output.
   */
  notes?: string;
};

export type ReadinessStatus = "READY" | "PARTIAL" | "BLOCKED";

export type ReadinessCheckSeverity = "required" | "recommended";

export type ReadinessCheckResult = {
  id: string;
  label: string;
  severity: ReadinessCheckSeverity;
  passed: boolean;
  status: "pass" | "partial" | "blocked";
  detail: string;
  missingField?: string;
};

export type ReadinessReport = {
  status: ReadinessStatus;
  totalChecks: number;
  passed: number;
  partial: number;
  blocked: number;
  missingFields: string[];
  masterGuard: {
    forbiddenMasterId: string;
    locationIsMaster: boolean;
    passed: boolean;
  };
  checks: ReadinessCheckResult[];
  highlevelPlan: "$297 Unlimited";
  notDependentOn: string[];
  clientSlug?: string;
  businessName?: string;
};

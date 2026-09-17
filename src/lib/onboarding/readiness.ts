import { BRAND } from "@/lib/brand";
import type {
  ClientConfig,
  ReadinessCheckResult,
  ReadinessReport,
  ReadinessStatus,
} from "./types";

export const FORBIDDEN_MASTER_LOCATION_ID = BRAND.forbiddenMasterId;

export const NOT_DEPENDENT_ON = [
  "$497 Agency Pro",
  "Advanced OAuth",
  "agency-level CRM API",
  "white-label native mobile app add-on",
] as const;

const PLACEHOLDER_RE =
  /(placeholder|replace_me|replace-me|todo|tbd|your_|changeme|\{\{|\}\}|example\.com\/your|pending|not-set|^x+$)/i;

export function isBlank(value: unknown): boolean {
  return value == null || String(value).trim() === "";
}

export function looksLikePlaceholder(value: unknown): boolean {
  if (isBlank(value)) return true;
  const s = String(value).trim();
  if (PLACEHOLDER_RE.test(s)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(s)) return true;
  if (/^(https?:\/\/)?(www\.)?example\.(com|org|net)/i.test(s)) return true;
  return false;
}

function isSyntheticEmail(value: string): boolean {
  return /@example\.invalid$/i.test(value.trim());
}

function check(
  id: string,
  label: string,
  severity: "required" | "recommended",
  passed: boolean,
  detail: string,
  missingField?: string,
  force: "pass" | "partial" | "blocked" | null = null
): ReadinessCheckResult {
  let status: "pass" | "partial" | "blocked";
  if (force) status = force;
  else if (passed) status = "pass";
  else status = severity === "required" ? "blocked" : "partial";
  return { id, label, severity, passed, status, detail, missingField };
}

function emailCheck(
  id: string,
  label: string,
  field: string,
  value: string | undefined
): ReadinessCheckResult {
  if (isBlank(value)) {
    return check(id, label, "required", false, `${field} missing`, field, "blocked");
  }
  const v = String(value).trim();
  if (!v.includes("@")) {
    return check(id, label, "required", false, `${field} invalid`, field, "blocked");
  }
  // Synthetic E2E addresses are allowed as PARTIAL, not READY.
  if (isSyntheticEmail(v)) {
    return {
      id,
      label,
      severity: "required",
      passed: false,
      status: "partial",
      detail: `${field} is synthetic (@example.invalid) — replace before go-live`,
      missingField: field,
    };
  }
  if (looksLikePlaceholder(v) || /@example\.(com|org|net)$/i.test(v)) {
    return check(
      id,
      label,
      "required",
      false,
      `${field} is placeholder`,
      field,
      "blocked"
    );
  }
  return check(id, label, "required", true, `${label} OK`);
}

function urlCheck(
  id: string,
  label: string,
  field: string,
  value: string | undefined
): ReadinessCheckResult {
  if (isBlank(value)) {
    return check(id, label, "required", false, `${field} missing`, field, "blocked");
  }
  const v = String(value).trim();
  if (looksLikePlaceholder(v) || !/^https:\/\//i.test(v)) {
    return check(
      id,
      label,
      "required",
      false,
      `${field} is placeholder or not https`,
      field,
      "blocked"
    );
  }
  return check(id, label, "required", true, `${label} OK`);
}

/** Pure readiness evaluation from client config. No network I/O. */
export function evaluateClientReadiness(config: ClientConfig): ReadinessReport {
  const checks: ReadinessCheckResult[] = [];
  const locationId = config.ghl?.locationId?.trim() || "";
  const locationIsMaster = locationId === FORBIDDEN_MASTER_LOCATION_ID;

  checks.push(
    check(
      "location_id_present",
      "Location ID present",
      "required",
      !isBlank(locationId),
      isBlank(locationId) ? "ghl.locationId is missing" : "locationId present",
      isBlank(locationId) ? "ghl.locationId" : undefined
    )
  );

  checks.push(
    check(
      "master_guard",
      "Master location guard",
      "required",
      !locationIsMaster && config.sync?.masterGuard !== false,
      locationIsMaster
        ? "locationId is the protected Master — blocked"
        : config.sync?.masterGuard === false
          ? "sync.masterGuard is false"
          : "Master guard OK",
      locationIsMaster ? "ghl.locationId" : undefined,
      locationIsMaster ? "blocked" : null
    )
  );

  checks.push(
    check(
      "location_guard_flag",
      "Location guard enabled",
      "required",
      config.sync?.locationGuard === true,
      config.sync?.locationGuard === true
        ? "locationGuard enabled"
        : "sync.locationGuard must be true",
      "sync.locationGuard"
    )
  );

  checks.push(
    check(
      "pipeline_id",
      "Pipeline ID present",
      "required",
      !isBlank(config.ghl?.pipelineId) && !looksLikePlaceholder(config.ghl?.pipelineId),
      isBlank(config.ghl?.pipelineId) || looksLikePlaceholder(config.ghl?.pipelineId)
        ? "pipelineId missing or placeholder"
        : "pipelineId present",
      "ghl.pipelineId"
    )
  );

  const calendarIdOk =
    !isBlank(config.ghl?.bookingCalendarId) &&
    !looksLikePlaceholder(config.ghl?.bookingCalendarId);
  const calendarEnabled = config.channels?.calendarEnabled === true;
  checks.push({
    id: "calendar",
    label: "Booking calendar configured",
    severity: "required",
    passed: calendarIdOk && calendarEnabled,
    status: !calendarEnabled || !calendarIdOk ? "blocked" : "pass",
    detail: !calendarEnabled
      ? "channels.calendarEnabled is false"
      : !calendarIdOk
        ? "bookingCalendarId missing or placeholder"
        : "calendar configured",
    missingField: calendarIdOk && calendarEnabled ? undefined : "ghl.bookingCalendarId",
  });

  checks.push(
    emailCheck("support_email", "Support email configured", "business.supportEmail", config.business?.supportEmail)
  );
  checks.push(
    emailCheck(
      "lead_notification_email",
      "Lead notification email configured",
      "business.leadNotificationEmail",
      config.business?.leadNotificationEmail
    )
  );

  const phone = config.ghl?.phoneNumber || config.business?.businessPhone;
  checks.push(
    check(
      "phone",
      "Business phone configured",
      "required",
      !isBlank(phone) && !looksLikePlaceholder(phone),
      isBlank(phone) || looksLikePlaceholder(phone)
        ? "phone missing or placeholder"
        : "phone configured",
      "ghl.phoneNumber"
    )
  );

  checks.push(urlCheck("booking_url", "Booking URL configured", "ghl.bookingUrl", config.ghl?.bookingUrl));
  checks.push(
    urlCheck("reschedule_url", "Reschedule URL configured", "ghl.rescheduleUrl", config.ghl?.rescheduleUrl)
  );
  checks.push(urlCheck("review_url", "Review URL configured", "ghl.reviewUrl", config.ghl?.reviewUrl));
  checks.push(
    urlCheck(
      "logo_url",
      "Logo URL configured",
      "business.logoUrl",
      config.business?.logoUrl || config.branding?.logo
    )
  );
  checks.push(
    urlCheck(
      "webhook_destination",
      "Webhook destination configured",
      "sync.webhookDestination",
      config.sync?.webhookDestination
    )
  );

  checks.push(
    check(
      "webhook_secret",
      "Webhook secret configured",
      "required",
      config.sync?.webhookSecretConfigured === true,
      config.sync?.webhookSecretConfigured === true
        ? "webhook secret flag true"
        : "sync.webhookSecretConfigured must be true (secret value never returned)",
      "sync.webhookSecretConfigured"
    )
  );

  const writes = config.safety?.allowProductionWrites;
  checks.push(
    check(
      "production_writes_known",
      "Production writes state known",
      "required",
      writes === true || writes === false,
      writes === true || writes === false
        ? `allowProductionWrites=${writes}`
        : "safety.allowProductionWrites must be explicitly true or false",
      "safety.allowProductionWrites"
    )
  );

  const brandingOk =
    !isBlank(config.branding?.primaryColor) &&
    !isBlank(config.branding?.secondaryColor) &&
    !isBlank(config.branding?.backgroundColor) &&
    !looksLikePlaceholder(config.branding?.primaryColor);
  checks.push(
    check(
      "branding",
      "Client branding present",
      "required",
      brandingOk,
      brandingOk ? "branding colors present" : "branding colors incomplete",
      "branding.primaryColor"
    )
  );

  const users = config.ghl?.assignedUserIds || [];
  const usersOk =
    Array.isArray(users) &&
    users.length > 0 &&
    users.every((u) => !isBlank(u) && !looksLikePlaceholder(u));
  checks.push({
    id: "staff_users",
    label: "Required staff/users mapped",
    severity: "required",
    passed: usersOk,
    status: usersOk ? "pass" : "blocked",
    detail: usersOk
      ? `${users.length} user id(s) mapped`
      : "ghl.assignedUserIds missing or contains placeholders",
    missingField: usersOk ? undefined : "ghl.assignedUserIds",
  });

  checks.push(
    check(
      "business_name",
      "Business name present",
      "required",
      !isBlank(config.business?.businessName) && !looksLikePlaceholder(config.business?.businessName),
      isBlank(config.business?.businessName) || looksLikePlaceholder(config.business?.businessName)
        ? "businessName missing or placeholder"
        : "businessName present",
      "business.businessName"
    )
  );

  const stageEntries = Object.entries(config.ghl?.stageIds || {});
  const stagesOk =
    stageEntries.length > 0 &&
    stageEntries.every(([, id]) => !isBlank(id) && !looksLikePlaceholder(id));
  checks.push({
    id: "stage_ids",
    label: "Pipeline stage IDs mapped",
    severity: "required",
    passed: stagesOk,
    status: stagesOk ? "pass" : stageEntries.length === 0 ? "blocked" : "partial",
    detail: stagesOk
      ? `${stageEntries.length} stage id(s) mapped`
      : "ghl.stageIds missing or contains placeholders",
    missingField: stagesOk ? undefined : "ghl.stageIds",
  });

  const calendarEntries = Object.entries(config.ghl?.calendarIds || {});
  const calendarsMapOk =
    calendarEntries.length > 0 &&
    calendarEntries.every(([, id]) => !isBlank(id) && !looksLikePlaceholder(id));
  checks.push({
    id: "calendar_ids_map",
    label: "Calendar IDs mapped",
    severity: "required",
    passed: calendarsMapOk,
    status: calendarsMapOk ? "pass" : "blocked",
    detail: calendarsMapOk
      ? `${calendarEntries.length} calendar id(s) mapped`
      : "ghl.calendarIds missing or contains placeholders",
    missingField: calendarsMapOk ? undefined : "ghl.calendarIds",
  });

  const forbidden = config.forbiddenDependencies || {};
  const planOk =
    config.highlevelPlan === "$297 Unlimited" &&
    !forbidden.requiresAgencyPro497 &&
    !forbidden.requiresAdvancedOAuth &&
    !forbidden.requiresAgencyCrmApi &&
    !forbidden.requiresWhiteLabelMobileAddon;
  checks.push({
    id: "plan_297_only",
    label: "$297 plan compatibility (no $497/OAuth/Advanced API)",
    severity: "required",
    passed: planOk,
    status: planOk ? "pass" : "blocked",
    detail: planOk
      ? "Config stays on $297 Unlimited without forbidden dependencies"
      : "Config introduces $497 / OAuth / agency CRM API / WL mobile addon dependency",
    missingField: planOk ? undefined : "forbiddenDependencies",
  });

  const passed = checks.filter((c) => c.status === "pass").length;
  const partial = checks.filter((c) => c.status === "partial").length;
  const blocked = checks.filter((c) => c.status === "blocked").length;
  const missingFields = [
    ...new Set(checks.filter((c) => !c.passed && c.missingField).map((c) => c.missingField!)),
  ];

  let status: ReadinessStatus = "READY";
  if (blocked > 0) status = "BLOCKED";
  else if (partial > 0) status = "PARTIAL";

  return {
    status,
    totalChecks: checks.length,
    passed,
    partial,
    blocked,
    missingFields,
    masterGuard: {
      forbiddenMasterId: FORBIDDEN_MASTER_LOCATION_ID,
      locationIsMaster,
      passed: !locationIsMaster,
    },
    checks,
    highlevelPlan: "$297 Unlimited",
    notDependentOn: [...NOT_DEPENDENT_ON],
    clientSlug: config.clientSlug,
    businessName: config.business?.businessName,
  };
}

/** Public API shape — never includes secrets or tokens. */
export function toPublicReadinessPayload(report: ReadinessReport) {
  return {
    ok: true,
    status: report.status,
    totalChecks: report.totalChecks,
    passed: report.passed,
    partial: report.partial,
    blocked: report.blocked,
    missingFields: report.missingFields,
    masterGuard: report.masterGuard,
    highlevelPlan: report.highlevelPlan,
    notDependentOn: report.notDependentOn,
    clientSlug: report.clientSlug,
    businessName: report.businessName,
    checks: report.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      detail: c.detail,
      missingField: c.missingField,
    })),
  };
}

export function emptyClientConfig(): ClientConfig {
  return {
    schemaVersion: "1.0",
    clientSlug: "",
    highlevelPlan: "$297 Unlimited",
    business: {
      businessName: "",
      legalBusinessName: "",
      industry: "",
      address: "",
      city: "",
      state: "",
      zip: "",
      timezone: "US/Eastern",
      businessPhone: "",
      supportEmail: "",
      leadNotificationEmail: "",
      websiteUrl: "",
      logoUrl: "",
    },
    ghl: {
      locationId: "",
      pipelineId: "",
      pipelineName: "",
      stageIds: {},
      bookingCalendarId: "",
      calendarIds: {},
      bookingUrl: "",
      rescheduleUrl: "",
      reviewUrl: "",
      assignedUserIds: [],
      phoneNumber: "",
      domain: "",
    },
    branding: {
      primaryColor: "",
      secondaryColor: "",
      backgroundColor: "",
      logo: "",
      favicon: "",
    },
    channels: {
      smsEnabled: false,
      emailEnabled: false,
      voiceEnabled: false,
      reviewEnabled: false,
      calendarEnabled: false,
    },
    ai: {
      conversationAiEnabled: false,
      voiceAiEnabled: false,
      aiBusinessName: "",
      aiGreeting: "",
      aiEscalationTarget: "",
    },
    sync: {
      webhookDestination: "",
      webhookSecretConfigured: false,
      locationGuard: true,
      masterGuard: true,
    },
    payments: {
      stripeConnected: false,
      paymentsEnabled: false,
    },
    safety: {
      allowProductionWrites: false,
      dryRun: true,
      fakeContactOnly: true,
    },
  };
}

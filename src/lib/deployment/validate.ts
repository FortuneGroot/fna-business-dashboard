import type { ClientConfig } from "@/lib/onboarding/types";
import {
  evaluateClientReadiness,
  looksLikePlaceholder,
} from "@/lib/onboarding";
import { PROTECTED_MASTER_LOCATION_ID } from "@/lib/tenant";

export type EnvPresence = {
  GHL_API_TOKEN: "PRESENT" | "MISSING";
  GHL_WEBHOOK_SECRET: "PRESENT" | "MISSING";
  SUPABASE_URL: "PRESENT" | "MISSING";
  SUPABASE_SERVICE_ROLE_KEY: "PRESENT" | "MISSING";
  AUTH_SECRET: "PRESENT" | "MISSING";
  AUTH_OWNER_CREDENTIALS: "PRESENT" | "MISSING";
};

export function secretPresence(env: NodeJS.ProcessEnv = process.env): EnvPresence {
  const ownerEmail = (env.AUTH_OWNER_EMAIL || "").trim();
  const ownerPass = (env.AUTH_OWNER_PASSWORD || "").trim();
  return {
    GHL_API_TOKEN: (env.GHL_API_TOKEN || "").trim() ? "PRESENT" : "MISSING",
    GHL_WEBHOOK_SECRET: (env.GHL_WEBHOOK_SECRET || "").trim() ? "PRESENT" : "MISSING",
    SUPABASE_URL: (env.SUPABASE_URL || "").trim() ? "PRESENT" : "MISSING",
    SUPABASE_SERVICE_ROLE_KEY: (env.SUPABASE_SERVICE_ROLE_KEY || "").trim()
      ? "PRESENT"
      : "MISSING",
    AUTH_SECRET: (env.AUTH_SECRET || "").trim() ? "PRESENT" : "MISSING",
    AUTH_OWNER_CREDENTIALS: ownerEmail && ownerPass ? "PRESENT" : "MISSING",
  };
}

export type ValidateReport = {
  status: "READY" | "PARTIAL" | "BLOCKED";
  clientSlug: string;
  locationId: string;
  pipelineId: string;
  masterBlocked: boolean;
  secrets: EnvPresence;
  blockers: string[];
  warnings: string[];
  readinessStatus: "READY" | "PARTIAL" | "BLOCKED";
};

export function validateClientDeployment(
  config: ClientConfig,
  env: NodeJS.ProcessEnv = process.env
): ValidateReport {
  const readiness = evaluateClientReadiness(config);
  const secrets = secretPresence(env);
  const blockers: string[] = [];
  const warnings: string[] = [];

  const loc = (config.ghl?.locationId || "").trim();
  const pipe = (config.ghl?.pipelineId || "").trim();

  if (loc === PROTECTED_MASTER_LOCATION_ID) {
    blockers.push("Master location ID is absolutely forbidden");
  }
  if (!loc || looksLikePlaceholder(loc)) blockers.push("Client location missing or placeholder");
  if (!pipe || looksLikePlaceholder(pipe)) blockers.push("Pipeline missing or placeholder");

  const stages = Object.entries(config.ghl?.stageIds || {});
  if (!stages.length || stages.some(([, id]) => looksLikePlaceholder(id))) {
    blockers.push("Stage IDs missing or placeholder");
  }
  const cals = Object.entries(config.ghl?.calendarIds || {});
  if (
    looksLikePlaceholder(config.ghl?.bookingCalendarId) ||
    !cals.length ||
    cals.some(([, id]) => looksLikePlaceholder(id))
  ) {
    blockers.push("Calendar IDs missing or placeholder");
  }
  const users = config.ghl?.assignedUserIds || [];
  if (!users.length || users.some((u) => looksLikePlaceholder(u))) {
    blockers.push("User/staff IDs missing or placeholder");
  }
  for (const [label, url] of [
    ["bookingUrl", config.ghl?.bookingUrl],
    ["reviewUrl", config.ghl?.reviewUrl],
    ["webhookDestination", config.sync?.webhookDestination],
  ] as const) {
    if (!url || looksLikePlaceholder(url)) blockers.push(`${label} missing or placeholder`);
  }
  if (!config.business?.supportEmail || looksLikePlaceholder(config.business.supportEmail)) {
    blockers.push("Support email missing or placeholder");
  }
  if (
    !config.business?.leadNotificationEmail ||
    looksLikePlaceholder(config.business.leadNotificationEmail)
  ) {
    blockers.push("Lead notification email missing or placeholder");
  }

  if (config.forbiddenDependencies?.requiresAgencyPro497) {
    blockers.push("$497 Agency Pro dependency flagged — not allowed on $297 plan");
  }
  if (config.forbiddenDependencies?.requiresAdvancedOAuth) {
    blockers.push("Advanced OAuth dependency flagged — not allowed");
  }
  if (config.forbiddenDependencies?.requiresAgencyCrmApi) {
    blockers.push("Agency CRM API dependency flagged — not allowed");
  }

  if (config.safety?.allowProductionWrites === true && config.safety?.dryRun !== false) {
    blockers.push("Unsafe: production writes with dry-run still true");
  }
  if (config.safety?.allowProductionWrites === true) {
    warnings.push("Production contact writes enabled — confirm intentional");
  }

  if (secrets.GHL_WEBHOOK_SECRET === "MISSING") {
    blockers.push("GHL_WEBHOOK_SECRET missing (presence flag)");
  }
  if (secrets.GHL_API_TOKEN === "MISSING") {
    warnings.push("GHL_API_TOKEN missing — health probe will be unconfigured");
  }
  // Real-client gate: auth is required for READY (not merely a warning).
  if (secrets.AUTH_SECRET === "MISSING") {
    blockers.push("AUTH_SECRET missing — required for real-client / Production");
  }
  if (secrets.AUTH_OWNER_CREDENTIALS === "MISSING") {
    blockers.push("AUTH_OWNER credentials missing — required for dashboard login");
  }

  const envLoc = (env.GHL_LOCATION_ID || "").trim();
  if (envLoc && loc && envLoc !== loc) {
    blockers.push(
      `GHL_LOCATION_ID (${envLoc}) must match config locationId (${loc}) — refusing mismatch`
    );
  }
  if (envLoc === PROTECTED_MASTER_LOCATION_ID) {
    blockers.push("GHL_LOCATION_ID is the protected Master");
  }
  const envPipe = (env.GHL_PIPELINE_ID || "").trim();
  if (envPipe && pipe && envPipe !== pipe) {
    blockers.push(
      `GHL_PIPELINE_ID (${envPipe}) must match config pipelineId (${pipe}) — refusing mismatch`
    );
  }
  if (secrets.SUPABASE_URL === "PRESENT" && secrets.SUPABASE_SERVICE_ROLE_KEY === "MISSING") {
    blockers.push("SUPABASE_URL set but SUPABASE_SERVICE_ROLE_KEY missing");
  }

  for (const c of readiness.checks.filter((x) => !x.passed && x.severity === "required")) {
    if (!blockers.some((b) => b.includes(c.detail) || c.detail.includes(b))) {
      blockers.push(c.detail);
    }
  }

  let status: ValidateReport["status"] = "READY";
  if (blockers.length) status = "BLOCKED";
  else if (warnings.length || readiness.status === "PARTIAL") status = "PARTIAL";

  return {
    status,
    clientSlug: config.clientSlug,
    locationId: loc,
    pipelineId: pipe,
    masterBlocked: loc === PROTECTED_MASTER_LOCATION_ID,
    secrets,
    blockers,
    warnings,
    readinessStatus: readiness.status,
  };
}

export type ChecklistSection = {
  name: string;
  ok: boolean;
  detail: string;
};

export function buildClientPrepChecklist(config: ClientConfig, env?: NodeJS.ProcessEnv): {
  sections: ChecklistSection[];
  report: ValidateReport;
} {
  const report = validateClientDeployment(config, env);
  const stages = Object.keys(config.ghl.stageIds || {});
  const cals = Object.keys(config.ghl.calendarIds || {}).filter((k) => k !== "primaryBooking");
  const users = config.ghl.assignedUserIds || [];

  const sections: ChecklistSection[] = [
    {
      name: "CLIENT",
      ok: Boolean(config.business.businessName) && !looksLikePlaceholder(config.business.businessName),
      detail: config.business.businessName || "(missing)",
    },
    {
      name: "LOCATION",
      ok: Boolean(report.locationId) && !looksLikePlaceholder(report.locationId) && !report.masterBlocked,
      detail: report.masterBlocked ? "MASTER BLOCKED" : report.locationId || "(missing)",
    },
    {
      name: "PIPELINE",
      ok: Boolean(report.pipelineId) && !looksLikePlaceholder(report.pipelineId),
      detail: `${config.ghl.pipelineName || "Sales Pipeline"} (${report.pipelineId || "—"})`,
    },
    {
      name: "STAGES",
      ok: stages.length > 0 && Object.values(config.ghl.stageIds).every((id) => !looksLikePlaceholder(id)),
      detail: `${stages.length} stage(s)`,
    },
    {
      name: "CALENDARS",
      ok:
        !looksLikePlaceholder(config.ghl.bookingCalendarId) &&
        cals.length > 0 &&
        Object.values(config.ghl.calendarIds).every((id) => !looksLikePlaceholder(id)),
      detail: `${cals.length || 0} calendar(s)`,
    },
    {
      name: "USERS",
      ok: users.length > 0 && users.every((u) => !looksLikePlaceholder(u)),
      detail: `${users.length} mapped user(s)`,
    },
    {
      name: "BRANDING",
      ok: Boolean(config.branding.primaryColor) && !looksLikePlaceholder(config.branding.primaryColor),
      detail: config.branding.primaryColor || "(missing)",
    },
    {
      name: "BOOKING",
      ok: Boolean(config.ghl.bookingUrl) && !looksLikePlaceholder(config.ghl.bookingUrl),
      detail: looksLikePlaceholder(config.ghl.bookingUrl) ? "placeholder" : "configured",
    },
    {
      name: "REVIEWS",
      ok: Boolean(config.ghl.reviewUrl) && !looksLikePlaceholder(config.ghl.reviewUrl),
      detail: looksLikePlaceholder(config.ghl.reviewUrl) ? "placeholder" : "configured",
    },
    {
      name: "WEBHOOK",
      ok:
        Boolean(config.sync.webhookDestination) &&
        !looksLikePlaceholder(config.sync.webhookDestination) &&
        report.secrets.GHL_WEBHOOK_SECRET === "PRESENT",
      detail: `dest=${looksLikePlaceholder(config.sync.webhookDestination) ? "placeholder" : "ok"}; secret=${report.secrets.GHL_WEBHOOK_SECRET}`,
    },
    {
      name: "DATABASE",
      ok:
        report.secrets.SUPABASE_URL === "MISSING" ||
        (report.secrets.SUPABASE_URL === "PRESENT" &&
          report.secrets.SUPABASE_SERVICE_ROLE_KEY === "PRESENT"),
      detail:
        report.secrets.SUPABASE_URL === "MISSING"
          ? "memory fallback (ok for Preview)"
          : `supabase url=${report.secrets.SUPABASE_URL}; key=${report.secrets.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    {
      name: "MASTER GUARD",
      ok: !report.masterBlocked && config.sync.masterGuard !== false,
      detail: report.masterBlocked ? "FAIL" : "absolute block armed",
    },
    {
      name: "WRITE SAFETY",
      ok: config.safety?.allowProductionWrites !== true || config.safety?.dryRun === false,
      detail: `dryRun=${config.safety?.dryRun !== false}; allowWrites=${config.safety?.allowProductionWrites === true}`,
    },
  ];

  return { sections, report };
}

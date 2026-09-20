#!/usr/bin/env node
/**
 * Non-mutating installation doctor / preflight.
 * Reports configured / missing / invalid states without printing credential values.
 *
 * Usage:
 *   npm run install:doctor
 *   npm run install:doctor -- config/examples/synthetic-ready-client.json
 */
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  evaluateClientReadiness,
  loadClientConfigFromFile,
  toPublicReadinessPayload,
} from "../src/lib/onboarding";
import {
  FA_LIVE_LOCATION_ID,
  PROTECTED_MASTER_LOCATION_ID,
  faLiveDefaultClientConfig,
  loadTenantConfigFromEnv,
} from "../src/lib/tenant";
import { validateClientDeployment } from "../src/lib/deployment/validate";
import { isSupabaseConfigured } from "../src/lib/sync/db-client";
import { isAuthEnforced, isAuthFailClosed } from "../src/lib/auth";

type Flag = "configured" | "missing" | "invalid" | "present_name_only";

function envFlag(name: string): Flag {
  const v = (process.env[name] || "").trim();
  if (!v) return "missing";
  return "present_name_only";
}

function main() {
  const argPath = process.argv[2];
  let config;
  let label: string;
  if (argPath) {
    label = resolve(argPath);
    if (!existsSync(label)) {
      console.error(JSON.stringify({ ok: false, error: "config_file_missing", path: label }));
      process.exit(2);
    }
    config = loadClientConfigFromFile(label);
  } else if (process.env.CLIENT_CONFIG_PATH?.trim()) {
    config = loadTenantConfigFromEnv(process.env, process.cwd());
    label = process.env.CLIENT_CONFIG_PATH;
  } else {
    config = faLiveDefaultClientConfig();
    label = "(embedded F&A LIVE default)";
  }

  const deployment = validateClientDeployment(config);
  const readiness = evaluateClientReadiness(config);
  const publicReadiness = toPublicReadinessPayload(readiness);

  const loc = (config.ghl?.locationId || "").trim();
  const pipe = (config.ghl?.pipelineId || "").trim();
  const envLoc = (process.env.GHL_LOCATION_ID || "").trim();
  const envPipe = (process.env.GHL_PIPELINE_ID || "").trim();

  const architecture = {
    model: "deployment-per-client",
    multiTenantSharedRouter: false,
    note: "One Vercel deployment + one CLIENT_CONFIG_PATH + one GHL_LOCATION_ID. Do not share F&A live webhook secret across clients.",
  };

  const disconnectedFromFaLive =
    loc !== "" &&
    loc !== FA_LIVE_LOCATION_ID &&
    loc !== PROTECTED_MASTER_LOCATION_ID &&
    (envLoc === "" || envLoc === loc);

  const report = {
    ok: deployment.status !== "BLOCKED" && readiness.status !== "BLOCKED",
    architecture,
    configLabel: label,
    clientBusinessName: config.business?.businessName || null,
    locationBinding: {
      configLocationSet: Boolean(loc),
      envLocationSet: Boolean(envLoc),
      matchesEnv: !envLoc || envLoc === loc,
      isFaLiveDefault: loc === FA_LIVE_LOCATION_ID,
      isProtectedMaster: loc === PROTECTED_MASTER_LOCATION_ID,
      disconnectedFromFaLive,
    },
    pipelineBinding: {
      configPipelineSet: Boolean(pipe),
      envPipelineSet: Boolean(envPipe),
      matchesEnv: !envPipe || envPipe === pipe,
    },
    envPresence: {
      AUTH_SECRET: envFlag("AUTH_SECRET"),
      AUTH_OWNER_EMAIL: envFlag("AUTH_OWNER_EMAIL"),
      AUTH_OWNER_PASSWORD: envFlag("AUTH_OWNER_PASSWORD"),
      AUTH_ADMIN_EMAIL: envFlag("AUTH_ADMIN_EMAIL"),
      AUTH_CLIENT_EMAIL: envFlag("AUTH_CLIENT_EMAIL"),
      GHL_WEBHOOK_SECRET: envFlag("GHL_WEBHOOK_SECRET"),
      GHL_API_TOKEN: envFlag("GHL_API_TOKEN"),
      SUPABASE_URL: envFlag("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: envFlag("SUPABASE_SERVICE_ROLE_KEY"),
      CLIENT_CONFIG_PATH: envFlag("CLIENT_CONFIG_PATH"),
    },
    runtimeFlags: {
      authEnforced: isAuthEnforced(),
      authFailClosed: isAuthFailClosed(),
      supabaseConfigured: isSupabaseConfigured(),
      vercelEnv: (process.env.VERCEL_ENV || "").trim() || "(unset)",
      dryRun: (process.env.GHL_DRY_RUN || "true").toLowerCase() !== "false",
    },
    migrations: {
      authSessionsSql: existsSync(resolve("supabase/migrations/20260917_auth_sessions.sql"))
        ? "file_present_apply_status_unknown"
        : "missing",
      syncStoreSql: existsSync(resolve("supabase/migrations/20260917_sync_store.sql"))
        ? "file_present_apply_status_unknown"
        : "missing",
    },
    deploymentStatus: deployment.status,
    readinessStatus: readiness.status,
    readinessPublic: publicReadiness,
    blockingReasons: [
      ...(deployment.blockers || []),
      ...readiness.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.label}`),
    ],
    ownerEmailContract: {
      note: "Owner contact facts are not auth credentials. Do not rewrite AUTH_OWNER_EMAIL from contact emails without explicit approval.",
      documentedPrimary: "george@fortuneandfinance.com",
      documentedWork: "automations@fortuneandfinance.com",
      authOwnerEmailConfigured: envFlag("AUTH_OWNER_EMAIL") !== "missing",
    },
  };

  const text = JSON.stringify(report, null, 2);
  // Block actual secret VALUE shapes — not env key names like AUTH_OWNER_PASSWORD.
  if (
    /pit-[A-Za-z0-9]{8,}|sb_secret_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]{20,}/i.test(
      text
    )
  ) {
    console.error("Refusing to print output that may contain secrets");
    process.exit(2);
  }
  console.log(text);
  if (report.locationBinding.isProtectedMaster) process.exit(1);
  if (deployment.status === "BLOCKED") process.exit(1);
  process.exit(0);
}

main();

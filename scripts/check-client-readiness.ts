#!/usr/bin/env node
/**
 * Client readiness checker — same tenant model as runtime.
 * Usage:
 *   npx tsx scripts/check-client-readiness.ts [path/to/client.json]
 *   CLIENT_CONFIG_PATH=... npm run check:readiness
 */
import { resolve } from "node:path";
import {
  evaluateClientReadiness,
  loadClientConfigFromFile,
  toPublicReadinessPayload,
} from "../src/lib/onboarding";
import {
  faLiveDefaultClientConfig,
  loadTenantConfigFromEnv,
  resetTenantConfigForTests,
} from "../src/lib/tenant";

function main() {
  const argPath = process.argv[2];
  let config;
  let pathLabel: string;
  if (argPath) {
    pathLabel = resolve(argPath);
    config = loadClientConfigFromFile(pathLabel);
    resetTenantConfigForTests(config);
  } else if (process.env.CLIENT_CONFIG_PATH?.trim()) {
    config = loadTenantConfigFromEnv(process.env, process.cwd());
    pathLabel = process.env.CLIENT_CONFIG_PATH;
  } else {
    config = faLiveDefaultClientConfig();
    pathLabel = "(embedded F&A LIVE default)";
  }

  const report = evaluateClientReadiness(config);
  const publicReport = toPublicReadinessPayload(report);

  const serialized = JSON.stringify(publicReport, null, 2);
  if (/GHL_API_TOKEN|SUPABASE_SERVICE_ROLE|webhookSecret"\s*:|password|Bearer /i.test(serialized)) {
    console.error("BLOCKED: refusing to print output that may contain secrets");
    process.exit(2);
  }

  console.log(`CONFIG ${pathLabel}`);
  console.log(`STATUS ${report.status}`);
  console.log(serialized);

  if (report.status === "BLOCKED") process.exit(1);
  process.exit(0);
}

main();

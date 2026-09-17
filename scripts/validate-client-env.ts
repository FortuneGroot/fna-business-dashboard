#!/usr/bin/env node
/**
 * Validate client config + env presence flags.
 * Usage: npx tsx scripts/validate-client-env.ts [config/path.json]
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
} from "../src/lib/tenant";
import { validateClientDeployment } from "../src/lib/deployment/validate";

function main() {
  const argPath = process.argv[2];
  let config;
  let label: string;
  if (argPath) {
    label = resolve(argPath);
    config = loadClientConfigFromFile(label);
  } else if (process.env.CLIENT_CONFIG_PATH?.trim()) {
    config = loadTenantConfigFromEnv(process.env, process.cwd());
    label = process.env.CLIENT_CONFIG_PATH;
  } else {
    config = faLiveDefaultClientConfig();
    label = "(embedded F&A LIVE default)";
  }

  const report = validateClientDeployment(config);
  const publicReadiness = toPublicReadinessPayload(evaluateClientReadiness(config));
  const out = { config: label, ...report, readinessPublic: publicReadiness };
  const text = JSON.stringify(out, null, 2);
  if (/pit-[A-Za-z0-9]|SERVICE_ROLE|Bearer /i.test(text)) {
    console.error("Refusing to print output that may contain secrets");
    process.exit(2);
  }
  console.log(text);
  console.log(`STATUS ${report.status}`);
  if (report.status === "BLOCKED") process.exit(1);
  process.exit(0);
}

main();

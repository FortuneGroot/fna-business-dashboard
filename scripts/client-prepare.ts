#!/usr/bin/env node
/**
 * Client deployment prep checklist — no network writes.
 *
 * Usage:
 *   npm run client:prepare -- config/examples/fake-roofing-client.json
 *   npx tsx scripts/client-prepare.ts config/path.json
 */
import { resolve } from "node:path";
import { loadClientConfigFromFile } from "../src/lib/onboarding";
import {
  faLiveDefaultClientConfig,
  loadTenantConfigFromEnv,
} from "../src/lib/tenant";
import { buildClientPrepChecklist } from "../src/lib/deployment/validate";

function pad(label: string, width = 14) {
  return label.padEnd(width);
}

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

  const { sections, report } = buildClientPrepChecklist(config);
  console.log("=== F&A CLIENT DEPLOYMENT PREP ===");
  console.log(`CONFIG  ${label}`);
  console.log(`SLUG    ${config.clientSlug}`);
  console.log(`PLAN    ${config.highlevelPlan}`);
  console.log("");
  for (const s of sections) {
    const mark = s.ok ? "OK  " : "FAIL";
    console.log(`${mark}  ${pad(s.name)}  ${s.detail}`);
  }
  console.log("");
  if (report.blockers.length) {
    console.log("BLOCKERS:");
    for (const b of report.blockers) console.log(`  - ${b}`);
  }
  if (report.warnings.length) {
    console.log("WARNINGS:");
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
  console.log("");
  console.log(`SECRETS (presence only):`);
  for (const [k, v] of Object.entries(report.secrets)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("");
  console.log(`STATUS ${report.status}`);
  console.log("No network writes performed.");
  if (report.status === "BLOCKED") process.exit(1);
  process.exit(0);
}

main();

#!/usr/bin/env node
/**
 * Client readiness checker — config-only, no network writes.
 * Usage:
 *   npx tsx scripts/check-client-readiness.ts [path/to/client.json]
 *   CLIENT_CONFIG_PATH=... npm run check:readiness
 */
import { resolve } from "node:path";
import {
  evaluateClientReadiness,
  loadClientConfigFromFile,
  loadResolvedClientConfig,
  toPublicReadinessPayload,
} from "../src/lib/onboarding";

function main() {
  const argPath = process.argv[2];
  const loaded = argPath
    ? { config: loadClientConfigFromFile(resolve(argPath)), path: resolve(argPath) }
    : loadResolvedClientConfig(process.cwd(), process.env);

  const report = evaluateClientReadiness(loaded.config);
  const publicReport = toPublicReadinessPayload(report);

  // Ensure no secret-looking keys leak to stdout
  const serialized = JSON.stringify(publicReport, null, 2);
  if (/GHL_API_TOKEN|SUPABASE_SERVICE_ROLE|webhookSecret"\s*:|password|Bearer /i.test(serialized)) {
    console.error("BLOCKED: refusing to print output that may contain secrets");
    process.exit(2);
  }

  console.log(`CONFIG ${loaded.path || "(empty default)"}`);
  console.log(`STATUS ${report.status}`);
  console.log(serialized);

  if (report.status === "BLOCKED") process.exit(1);
  if (report.status === "PARTIAL") process.exit(0);
  process.exit(0);
}

main();

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ClientConfig } from "./types";
import { emptyClientConfig } from "./readiness";

export function parseClientConfig(raw: unknown): ClientConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Client config must be a JSON object");
  }
  const base = emptyClientConfig();
  const incoming = raw as Partial<ClientConfig>;
  return {
    ...base,
    ...incoming,
    schemaVersion: "1.0",
    highlevelPlan: "$297 Unlimited",
    business: { ...base.business, ...(incoming.business || {}) },
    ghl: { ...base.ghl, ...(incoming.ghl || {}) },
    branding: { ...base.branding, ...(incoming.branding || {}) },
    channels: { ...base.channels, ...(incoming.channels || {}) },
    ai: { ...base.ai, ...(incoming.ai || {}) },
    sync: { ...base.sync, ...(incoming.sync || {}) },
    payments: { ...base.payments, ...(incoming.payments || {}) },
    safety: { ...base.safety, ...(incoming.safety || {}) },
  };
}

export function loadClientConfigFromFile(filePath: string): ClientConfig {
  const abs = resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Client config not found: ${abs}`);
  }
  const text = readFileSync(abs, "utf8");
  return parseClientConfig(JSON.parse(text));
}

/**
 * Resolve config for API / scripts.
 * CLIENT_CONFIG_PATH env wins; otherwise optional default path.
 * Never reads secrets from the file into API responses (readiness strips them).
 */
export function resolveClientConfigPath(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (env.CLIENT_CONFIG_PATH?.trim()) return resolve(cwd, env.CLIENT_CONFIG_PATH.trim());
  const fallback = resolve(cwd, "config/examples/fake-roofing-client.json");
  return existsSync(fallback) ? fallback : null;
}

export function loadResolvedClientConfig(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): { config: ClientConfig; path: string | null } {
  const path = resolveClientConfigPath(cwd, env);
  if (!path) return { config: emptyClientConfig(), path: null };
  return { config: loadClientConfigFromFile(path), path };
}

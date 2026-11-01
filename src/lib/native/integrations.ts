import "server-only";
import type { DataScope } from "@/lib/data/query";
import { fromWorkspaceRows } from "./shared";

export type IntegrationItem = {
  provider: string;
  status: "disconnected" | "connected" | "error";
  capabilities: string[];
  verifiedAt: string | null;
  config: Record<string, unknown>;
  updatedAt: string;
};

type RawIntegration = {
  provider: string;
  status: IntegrationItem["status"];
  capabilities: string[] | null;
  verified_at: string | null;
  config: Record<string, unknown> | null;
  updated_at: string;
};

const SECRET_LIKE = /secret|token|password|passwd|api[_-]?key|private|credential|auth/i;

/** Config is non-secret by design (credentials live in integration_secrets); keys that look secret are dropped anyway. */
export function publicConfig(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return Object.fromEntries(Object.entries(config).filter(([k]) => !SECRET_LIKE.test(k)));
}

/**
 * Integrations of the active workspace (integrations.read). Status, capabilities and verification
 * are server-controlled (M9 trigger); this endpoint only reports them and never reads secrets.
 */
export async function listIntegrations(scope: DataScope): Promise<IntegrationItem[]> {
  const rows = await fromWorkspaceRows<RawIntegration>(
    scope,
    "integrations",
    "provider, status, capabilities, verified_at, config, updated_at",
    (q) => q.order("provider")
  );
  return rows.map((r) => ({
    provider: r.provider,
    status: r.status,
    capabilities: r.capabilities ?? [],
    verifiedAt: r.verified_at,
    config: publicConfig(r.config),
    updatedAt: r.updated_at,
  }));
}

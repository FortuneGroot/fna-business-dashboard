import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role allowlist (spec §6.4). The only application module that reads
 * SUPABASE_SERVICE_ROLE_KEY for Supabase Auth mode. Every export documents its guard.
 *
 * A5 platformWriteWorkspaceLogo / platformDeleteWorkspaceLogo — Storage write policies are
 *    members-only, so a platform admin's logo change needs the service role. Guard: the caller has
 *    passed requireApiContext as a platform admin holding a live write grant, re-checked the session
 *    with getUser(), and rpc platform_storage_change_requested (run with the caller's JWT) authorized
 *    and audited this exact path. The workspace id comes from the request context, never the client.
 */

export const WORKSPACE_ASSETS_BUCKET = "workspace-assets";
export const LOGO_EXTENSIONS = ["png", "jpg", "webp"] as const;
export type LogoExtension = (typeof LOGO_EXTENSIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function workspaceLogoPath(workspaceId: string, ext: LogoExtension): string {
  if (!UUID.test(workspaceId) || !LOGO_EXTENSIONS.includes(ext)) throw new Error("invalid logo path");
  return `${workspaceId}/logo.${ext}`;
}

function adminClient() {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new Error("Supabase service role is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A5. Upserts `{workspaceId}/logo.{ext}`. Returns false on failure; never throws key material. */
export async function platformWriteWorkspaceLogo(
  workspaceId: string,
  ext: LogoExtension,
  bytes: Uint8Array,
  contentType: string
): Promise<boolean> {
  const { error } = await adminClient()
    .storage.from(WORKSPACE_ASSETS_BUCKET)
    .upload(workspaceLogoPath(workspaceId, ext), bytes, { upsert: true, contentType });
  return !error;
}

/** A5. Deletes `{workspaceId}/logo.{ext}`. */
export async function platformDeleteWorkspaceLogo(workspaceId: string, ext: LogoExtension): Promise<boolean> {
  const { data, error } = await adminClient()
    .storage.from(WORKSPACE_ASSETS_BUCKET)
    .remove([workspaceLogoPath(workspaceId, ext)]);
  return !error && Array.isArray(data) && data.length === 1;
}

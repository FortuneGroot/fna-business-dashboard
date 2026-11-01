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
 * A5 claimPlatformStorageChange / completePlatformStorageChange — claim a request for execution and
 *    record its outcome through the service-role-only rpcs platform_storage_change_claimed/_finished;
 *    the outcome is derived from the Storage object itself. Guard: the actor id comes from the
 *    caller's verified request context.
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
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Bounded, so a pending request is never still in flight when its outcome is recovered.
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
  });
}

const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_RETRY_DELAYS_MS = [100, 300];

export type ClaimResult = { ok: true } | { ok: false; code: "conflict" | "not_found" | "unavailable" };

/**
 * A5. Claims request `requestId` by `actorId` for execution, immediately before the write. Only claimed
 * requests can receive an outcome. `conflict`: another change to the same object is still pending.
 */
export async function claimPlatformStorageChange(requestId: number, actorId: string): Promise<ClaimResult> {
  try {
    const { error } = await adminClient().rpc("platform_storage_change_claimed", {
      p_request_id: requestId,
      p_actor_id: actorId,
    });
    if (!error) return { ok: true };
    if (error.message === "conflict") return { ok: false, code: "conflict" };
    if (error.message === "not_found") return { ok: false, code: "not_found" };
  } catch {
    // network failure or timeout
  }
  return { ok: false, code: "unavailable" };
}

export type CompletionResult =
  | { ok: true; outcome: "succeeded" | "failed" }
  | { ok: false; code: "not_found" | "unavailable" };

/**
 * A5. Records the outcome of pending request `requestId` by `actorId`. Retries transient failures;
 * safe to repeat because the RPC returns an already-recorded outcome instead of writing a second one.
 */
export async function completePlatformStorageChange(requestId: number, actorId: string): Promise<CompletionResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data, error } = await adminClient().rpc("platform_storage_change_finished", {
        p_request_id: requestId,
        p_actor_id: actorId,
      });
      if (!error && (data === "succeeded" || data === "failed")) return { ok: true, outcome: data };
      if (error?.message === "not_found") return { ok: false, code: "not_found" };
    } catch {
      // network failure or timeout: retried below
    }
    if (attempt >= COMPLETION_RETRY_DELAYS_MS.length) return { ok: false, code: "unavailable" };
    await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_DELAYS_MS[attempt]));
  }
}

/** A5. Upserts `{workspaceId}/logo.{ext}`. Returns false on failure; never throws key material. The
 * audited outcome is decided by the database, not by this return value. */
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

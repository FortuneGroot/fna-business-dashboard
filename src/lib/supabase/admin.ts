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
 *    the outcome is whether the database saw this request's own write (tagged with the operation
 *    token returned by the claim) commit. Guard: the actor id comes from the caller's verified
 *    request context; the token never leaves the server.
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
    // Bounded so a request cannot hang; a timeout does not prove the remote write stopped (see
    // platform_storage_change_finished), so it is reported as "no response", never as a failure.
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) },
  });
}

const REQUEST_TIMEOUT_MS = 30_000;
const COMPLETION_RETRY_DELAYS_MS = [100, 300];

const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The server's handle on one claimed Storage operation. */
export type PlatformOperation = { requestId: number; token: string };

export type ClaimResult =
  | { ok: true; operation: PlatformOperation }
  | { ok: false; code: "conflict" | "not_found" | "unavailable" };

/**
 * A5. Claims request `requestId` by `actorId` for execution, immediately before the write, and returns
 * the operation token the write must carry. Only claimed requests can receive an outcome.
 * `conflict`: another change to the same object is still pending.
 */
export async function claimPlatformStorageChange(requestId: number, actorId: string): Promise<ClaimResult> {
  try {
    const { data, error } = await adminClient().rpc("platform_storage_change_claimed", {
      p_request_id: requestId,
      p_actor_id: actorId,
    });
    if (!error && typeof data === "string" && UUID_TOKEN.test(data)) return { ok: true, operation: { requestId, token: data } };
    if (error?.message === "conflict") return { ok: false, code: "conflict" };
    if (error?.message === "not_found") return { ok: false, code: "not_found" };
  } catch {
    // network failure or timeout
  }
  return { ok: false, code: "unavailable" };
}

export type CompletionResult =
  | { ok: true; outcome: "succeeded" | "failed" | "pending" }
  | { ok: false; code: "not_found" | "unavailable" };

/**
 * A5. Records the outcome of request `requestId` by `actorId`. `operationReturned`: this server's
 * Storage call for the request got a response (false after a timeout or network error, and for
 * recovery). `pending`: the operation may still be running, so nothing was recorded. Retries transient
 * failures; safe to repeat because the RPC returns an already-recorded outcome.
 */
export async function completePlatformStorageChange(
  requestId: number,
  actorId: string,
  operationReturned: boolean
): Promise<CompletionResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data, error } = await adminClient().rpc("platform_storage_change_finished", {
        p_request_id: requestId,
        p_actor_id: actorId,
        p_operation_returned: operationReturned,
      });
      if (!error && (data === "succeeded" || data === "failed" || data === "pending")) return { ok: true, outcome: data };
      if (error?.message === "not_found") return { ok: false, code: "not_found" };
    } catch {
      // network failure or timeout: retried below
    }
    if (attempt >= COMPLETION_RETRY_DELAYS_MS.length) return { ok: false, code: "unavailable" };
    await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_DELAYS_MS[attempt]));
  }
}

/**
 * Whether a Storage call got an HTTP response (success or an error status). Network failures and
 * timeouts surface as errors without a status: the remote operation may still be running.
 */
function storageResponded(error: unknown): boolean {
  return !error || typeof (error as { status?: unknown }).status === "number";
}

/** `{workspaceId}/.platform-trash/{requestId}-{token}.{ext}` — must match private.platform_storage_tombstone. */
export function workspaceLogoTombstone(workspaceId: string, ext: LogoExtension, operation: PlatformOperation): string {
  workspaceLogoPath(workspaceId, ext);
  return `${workspaceId}/.platform-trash/${operation.requestId}-${operation.token}.${ext}`;
}

/**
 * A5. Upserts `{workspaceId}/logo.{ext}` tagged with the operation token. Returns whether the call got a
 * response; the audited outcome is decided by the database, never by this return value.
 */
export async function platformWriteWorkspaceLogo(
  workspaceId: string,
  ext: LogoExtension,
  bytes: Uint8Array,
  contentType: string,
  operation: PlatformOperation
): Promise<{ returned: boolean }> {
  try {
    const { error } = await adminClient()
      .storage.from(WORKSPACE_ASSETS_BUCKET)
      .upload(workspaceLogoPath(workspaceId, ext), bytes, {
        upsert: true,
        contentType,
        metadata: { platform_operation: operation.token },
      });
    return { returned: storageResponded(error) };
  } catch {
    return { returned: false };
  }
}

/**
 * A5. Deletes `{workspaceId}/logo.{ext}` as a move to the operation's tombstone (so the database can
 * attribute it to this operation), then removes the tombstone. A tombstone left by a failed cleanup
 * stays inside the workspace's own folder.
 */
export async function platformDeleteWorkspaceLogo(
  workspaceId: string,
  ext: LogoExtension,
  operation: PlatformOperation
): Promise<{ returned: boolean }> {
  const bucket = () => adminClient().storage.from(WORKSPACE_ASSETS_BUCKET);
  const tombstone = workspaceLogoTombstone(workspaceId, ext, operation);
  try {
    const { error } = await bucket().move(workspaceLogoPath(workspaceId, ext), tombstone);
    if (!error) await bucket().remove([tombstone]).catch(() => undefined);
    return { returned: storageResponded(error) };
  } catch {
    return { returned: false };
  }
}

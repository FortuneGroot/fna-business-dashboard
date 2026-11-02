import { NextRequest, NextResponse } from "next/server";
import { authProvider } from "@/lib/auth/provider";
import {
  denialResponse,
  requireApiContext,
  sessionStillValid,
  unavailableResponse,
  type ApiContext,
} from "@/lib/authz/context";
import { readJsonObject } from "@/lib/http/json-body";
import { readLimitedBody } from "@/lib/http/limited-body";
import { sniffLogo } from "@/lib/native/logo";
import {
  claimPlatformStorageChange,
  completePlatformStorageChange,
  LOGO_EXTENSIONS,
  platformDeleteWorkspaceLogo,
  platformWriteWorkspaceLogo,
  workspaceLogoObject,
  workspaceLogoPath,
  type CompletionResult,
  type LogoExtension,
  type PlatformOperation,
} from "@/lib/supabase/admin";
import { applyPendingCookies } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** Matches the lease in platform_storage_change_finished. */
const OPERATION_LEASE_SECONDS = 120;
const CONTENT_TYPES: Record<string, LogoExtension> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function json(status: number, error: string, code: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, code, ...extra }, { status });
}

type Authorized = { api: ApiContext; reply: (res: NextResponse) => NextResponse; error: NextResponse | null };

/**
 * Audited platform Storage change for the active workspace's logo (R2-3, decision A). Only a platform
 * admin holding a live write grant (and no membership) may change it; members use Storage directly.
 * The database authorizes and audits the request under the caller's JWT; the server claims it (one
 * open change per object), writes with the claim's operation token, and records (service role) whether
 * that write committed.
 */
async function authorize(req: NextRequest, needWriteGrant: boolean): Promise<Authorized> {
  const none = (res: NextResponse) => res;
  if (authProvider() !== "supabase") {
    return { api: null as never, reply: none, error: json(404, "Not found", "not_found") };
  }
  const api = await requireApiContext(req, { allowNoWorkspace: !needWriteGrant });
  const reply = (res: NextResponse) => applyPendingCookies(res, api.pending);
  if (api.error) return { api, reply, error: api.error };
  const ctx = api.ctx!;
  const allowed = needWriteGrant ? ctx.isPlatformAdmin && !ctx.role && ctx.grant?.mode === "write" : ctx.isPlatformAdmin;
  if (!allowed) return { api, reply, error: reply(denialResponse("forbidden")) };
  if (!(await sessionStillValid(api.supabase!, ctx))) return { api, reply, error: reply(denialResponse("unauthenticated")) };
  return { api, reply, error: null };
}

function completionResponse(done: CompletionResult, requestId: number, objectPath?: string): NextResponse {
  if (!done.ok && done.code === "not_found") return json(404, "No pending change with that request id", "not_found");
  if (!done.ok) {
    return json(503, "The change could not be confirmed in the audit log yet. Retry with this request id.",
      "audit_pending", { requestId });
  }
  if (done.outcome === "pending") {
    const res = json(409, "The Storage operation may still be running; its outcome is not known yet. Retry with this request id.",
      "operation_in_progress", { requestId });
    res.headers.set("Retry-After", String(OPERATION_LEASE_SECONDS));
    return res;
  }
  if (done.outcome === "failed") return json(502, "Storage change failed", "storage_failed", { requestId, outcome: "failed" });
  return NextResponse.json({ ok: true, requestId, outcome: "succeeded", ...(objectPath ? { objectPath } : {}) });
}

/** Records the logo through rpc set_workspace_logo with the caller's JWT; null when it worked. */
async function recordLogo(api: ApiContext, path: string | null, onlyIf?: string): Promise<NextResponse | null> {
  const { error } = await api.supabase!.rpc("set_workspace_logo", { p_path: path, ...(onlyIf ? { p_only_if: onlyIf } : {}) });
  if (!error) return null;
  if (error.message === "logo_missing") {
    return json(409, "The logo was changed at the same moment, so this upload was not made the logo. Try again.", "conflict");
  }
  if (error.message === "forbidden") return denialResponse("forbidden");
  return unavailableResponse();
}

/**
 * Runs one audited Storage operation on `path`. `beforePerform` runs while the claim is held (so no
 * other platform change to the same object can start); a response from it stops the operation, which
 * is then recorded as not performed. `afterSuccess` runs only when the database confirmed the change.
 */
async function audited(
  { api, reply }: Authorized,
  operation: "upsert" | "delete",
  path: string,
  perform: (workspaceId: string, operation: PlatformOperation) => Promise<{ returned: boolean }>,
  hooks: { beforePerform?: () => Promise<NextResponse | null>; afterSuccess?: () => Promise<NextResponse | null> } = {}
): Promise<NextResponse> {
  const workspaceId = api.ctx!.workspace!.id;
  const requested = await api.supabase!.rpc("platform_storage_change_requested", {
    p_operation: operation,
    p_object_path: path,
  });
  if (requested.error) {
    if (requested.error.message === "forbidden") return reply(denialResponse("forbidden"));
    if (requested.error.message === "validation_failed") return reply(json(422, "Invalid logo path", "validation_failed"));
    return reply(unavailableResponse());
  }
  const requestId = Number(requested.data);
  const claim = await claimPlatformStorageChange(requestId, api.ctx!.userId);
  if (!claim.ok) {
    if (claim.code === "conflict") {
      return reply(json(409, "Another change to this logo is still pending. Recover it first.", "change_pending"));
    }
    if (claim.code === "not_found") return reply(unavailableResponse());
    // The claim may have been recorded even though its response was lost: keep it recoverable.
    return reply(json(503, "The change could not be started. Recover this request id before retrying.", "unavailable", { requestId }));
  }
  const stop = hooks.beforePerform ? await hooks.beforePerform() : null;
  if (stop) {
    await completePlatformStorageChange(requestId, api.ctx!.userId, true);
    return reply(stop);
  }
  const { returned } = await perform(workspaceId, claim.operation);
  const done = await completePlatformStorageChange(requestId, api.ctx!.userId, returned);
  if (done.ok && done.outcome === "succeeded" && hooks.afterSuccess) {
    const failed = await hooks.afterSuccess();
    if (failed) return reply(failed);
  }
  return reply(completionResponse(done, requestId, path));
}

/**
 * Uploads `{workspace}/logo.{ext}` and, once the database confirms the write, records it as the logo.
 * A member logo it replaces stays private in the workspace folder until the next member logo change
 * removes leftovers.
 */
export async function PUT(req: NextRequest) {
  const auth = await authorize(req, true);
  if (auth.error) return auth.error;
  const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = CONTENT_TYPES[contentType];
  if (!ext) return auth.reply(json(422, "Logo must be PNG, JPEG, or WebP", "validation_failed"));
  const bytes = await readLimitedBody(req, MAX_LOGO_BYTES);
  if (!bytes || bytes.length === 0) {
    return auth.reply(json(422, "Logo must be 1 byte to 2 MB", "validation_failed"));
  }
  if (sniffLogo(bytes) !== ext) return auth.reply(json(422, "The file is not a valid image of that type", "validation_failed"));
  const path = workspaceLogoPath(auth.api.ctx!.workspace!.id, ext);
  return audited(auth, "upsert", path, (ws, op) => platformWriteWorkspaceLogo(ws, ext, bytes, contentType, op), {
    afterSuccess: () => recordLogo(auth.api, path),
  });
}

/**
 * `?ext=png|jpg|webp` deletes `{workspace}/logo.{ext}`; without `ext`, deletes the current logo
 * (whatever its name). The logo record is cleared first, while the claim on the object is held, so the
 * record never names a deleted object.
 */
export async function DELETE(req: NextRequest) {
  const auth = await authorize(req, true);
  if (auth.error) return auth.error;
  const ws = auth.api.ctx!.workspace!.id;
  const ext = req.nextUrl.searchParams.get("ext") as LogoExtension | null;
  let path: string;
  if (ext !== null) {
    if (!LOGO_EXTENSIONS.includes(ext)) return auth.reply(json(422, "ext must be png, jpg, or webp", "validation_failed"));
    path = workspaceLogoPath(ws, ext);
  } else {
    const { data, error } = await auth.api.supabase!.from("workspace_settings").select("logo_path").eq("workspace_id", ws).maybeSingle();
    if (error) return auth.reply(unavailableResponse());
    const current = (data as { logo_path: string | null } | null)?.logo_path ?? null;
    if (!current) return auth.reply(json(404, "This workspace has no logo", "not_found"));
    path = workspaceLogoObject(ws, current);
  }
  return audited(auth, "delete", path, (w, op) => platformDeleteWorkspaceLogo(w, path, op), {
    beforePerform: () => recordLogo(auth.api, null, path),
  });
}

/**
 * Recovers a pending change (`audit_pending`, `operation_in_progress`). Records its outcome only once
 * the operation can no longer be running (see platform_storage_change_finished); until then answers
 * `operation_in_progress` and keeps the claim. Only the platform admin who made the request; the
 * grant need not still be live.
 */
export async function POST(req: NextRequest) {
  const auth = await authorize(req, false);
  if (auth.error) return auth.error;
  const body = await readJsonObject(req);
  const requestId = body?.requestId;
  if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId <= 0) {
    return auth.reply(json(422, "requestId must be a positive integer", "validation_failed", { fields: { requestId: "invalid" } }));
  }
  return auth.reply(completionResponse(await completePlatformStorageChange(requestId, auth.api.ctx!.userId, false), requestId));
}

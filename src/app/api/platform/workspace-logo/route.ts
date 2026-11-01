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
import {
  claimPlatformStorageChange,
  completePlatformStorageChange,
  LOGO_EXTENSIONS,
  platformDeleteWorkspaceLogo,
  platformWriteWorkspaceLogo,
  workspaceLogoPath,
  type CompletionResult,
  type LogoExtension,
} from "@/lib/supabase/admin";
import { applyPendingCookies } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
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
 * open change per object), writes, and records the outcome (service role) from the Storage object itself.
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
  if (done.outcome === "failed") return json(502, "Storage change failed", "storage_failed", { requestId, outcome: "failed" });
  return NextResponse.json({ ok: true, requestId, outcome: "succeeded", ...(objectPath ? { objectPath } : {}) });
}

async function audited(
  { api, reply }: Authorized,
  operation: "upsert" | "delete",
  ext: LogoExtension,
  perform: (workspaceId: string) => Promise<unknown>
): Promise<NextResponse> {
  const workspaceId = api.ctx!.workspace!.id;
  const path = workspaceLogoPath(workspaceId, ext);
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
    return reply(unavailableResponse());
  }
  try {
    await perform(workspaceId);
  } catch {
    // The outcome is read from Storage by the database below, whatever happened here.
  }
  return reply(completionResponse(await completePlatformStorageChange(requestId, api.ctx!.userId), requestId, path));
}

export async function PUT(req: NextRequest) {
  const auth = await authorize(req, true);
  if (auth.error) return auth.error;
  const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = CONTENT_TYPES[contentType];
  if (!ext) return auth.reply(json(422, "Logo must be PNG, JPEG, or WebP", "validation_failed"));
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) {
    return auth.reply(json(422, "Logo must be 1 byte to 2 MB", "validation_failed"));
  }
  return audited(auth, "upsert", ext, (ws) => platformWriteWorkspaceLogo(ws, ext, bytes, contentType));
}

export async function DELETE(req: NextRequest) {
  const auth = await authorize(req, true);
  if (auth.error) return auth.error;
  const ext = req.nextUrl.searchParams.get("ext") as LogoExtension | null;
  if (!ext || !LOGO_EXTENSIONS.includes(ext)) return auth.reply(json(422, "ext must be png, jpg, or webp", "validation_failed"));
  return audited(auth, "delete", ext, (ws) => platformDeleteWorkspaceLogo(ws, ext));
}

/**
 * Recovers a pending change (`audit_pending`): records its outcome from the current Storage state.
 * Only the platform admin who made the request; the grant need not still be live.
 */
export async function POST(req: NextRequest) {
  const auth = await authorize(req, false);
  if (auth.error) return auth.error;
  const body = await readJsonObject(req);
  const requestId = body?.requestId;
  if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId <= 0) {
    return auth.reply(json(422, "requestId must be a positive integer", "validation_failed", { fields: { requestId: "invalid" } }));
  }
  return auth.reply(completionResponse(await completePlatformStorageChange(requestId, auth.api.ctx!.userId), requestId));
}

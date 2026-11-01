import { NextRequest, NextResponse } from "next/server";
import { authProvider } from "@/lib/auth/provider";
import {
  denialResponse,
  requireApiContext,
  sessionStillValid,
  unavailableResponse,
  type ApiContext,
} from "@/lib/authz/context";
import {
  LOGO_EXTENSIONS,
  platformDeleteWorkspaceLogo,
  platformWriteWorkspaceLogo,
  workspaceLogoPath,
  type LogoExtension,
} from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const CONTENT_TYPES: Record<string, LogoExtension> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function json(status: number, error: string, code: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/**
 * Audited platform Storage change for the active workspace's logo (R2-3, decision A). Only a platform
 * admin holding a live write grant (and no membership) may use it; members use Storage directly.
 * The database authorizes and audits the request under the caller's JWT before the write, and
 * records the outcome afterwards.
 */
async function authorize(req: NextRequest): Promise<{ api: ApiContext; error: NextResponse | null }> {
  if (authProvider() !== "supabase") return { api: null as never, error: json(404, "Not found", "not_found") };
  const api = await requireApiContext(req);
  if (api.error) return { api, error: api.error };
  const ctx = api.ctx!;
  if (!ctx.isPlatformAdmin || ctx.role || ctx.grant?.mode !== "write") {
    return { api, error: denialResponse("forbidden") };
  }
  if (!(await sessionStillValid(api.supabase!, ctx))) return { api, error: denialResponse("unauthenticated") };
  return { api, error: null };
}

async function audited(
  api: ApiContext,
  operation: "upsert" | "delete",
  ext: LogoExtension,
  perform: (workspaceId: string) => Promise<boolean>
): Promise<NextResponse> {
  const workspaceId = api.ctx!.workspace!.id;
  const path = workspaceLogoPath(workspaceId, ext);
  const requested = await api.supabase!.rpc("platform_storage_change_requested", {
    p_operation: operation,
    p_object_path: path,
  });
  if (requested.error) {
    if (requested.error.message === "forbidden") return denialResponse("forbidden");
    if (requested.error.message === "validation_failed") return json(422, "Invalid logo path", "validation_failed");
    return unavailableResponse();
  }
  let succeeded = false;
  try {
    succeeded = await perform(workspaceId);
  } finally {
    await api.supabase!.rpc("platform_storage_change_finished", {
      p_request_id: requested.data,
      p_succeeded: succeeded,
    });
  }
  if (!succeeded) return json(502, "Storage change failed", "storage_failed");
  return NextResponse.json({ ok: true, objectPath: path });
}

export async function PUT(req: NextRequest) {
  const { api, error } = await authorize(req);
  if (error) return error;
  const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = CONTENT_TYPES[contentType];
  if (!ext) return json(422, "Logo must be PNG, JPEG, or WebP", "validation_failed");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return json(422, "Logo must be 1 byte to 2 MB", "validation_failed");
  return audited(api, "upsert", ext, (ws) => platformWriteWorkspaceLogo(ws, ext, bytes, contentType));
}

export async function DELETE(req: NextRequest) {
  const { api, error } = await authorize(req);
  if (error) return error;
  const ext = req.nextUrl.searchParams.get("ext") as LogoExtension | null;
  if (!ext || !LOGO_EXTENSIONS.includes(ext)) return json(422, "ext must be png, jpg, or webp", "validation_failed");
  return audited(api, "delete", ext, (ws) => platformDeleteWorkspaceLogo(ws, ext));
}

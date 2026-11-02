import "server-only";
import { randomUUID } from "node:crypto";
import { ApiError, check, forbidden, invalid } from "@/lib/api/native";
import { activeWorkspaceId, type DataScope } from "@/lib/data/query";

/* Workspace logo (spec §6.6): private bucket `workspace-assets`, served through short-lived signed URLs.
 * The logo is the object named by workspace_settings.logo_path. Every upload gets a unique object name
 * (`{workspace_id}/logo-{uuid}.{ext}`) and becomes the logo only through rpc set_workspace_logo, which
 * swaps logo_path under a row lock after checking the object exists and returns the previous path, which
 * is then removed. Concurrent replacements and deletions therefore never remove each other's object, and
 * logo_path always names an object that exists. Every call uses the member's own JWT, so the Storage
 * policies (settings.read / settings.write in the active workspace) decide; the route checks the same
 * permissions first. Platform admins change logos through the audited platform endpoint. */

const BUCKET = "workspace-assets";
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const SIGNED_URL_SECONDS = 300;
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
type Ext = (typeof TYPES)[keyof typeof TYPES];
const LOGO_NAME = /^logo(-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(png|jpg|webp)$/;
/** Uploads not recorded as the logo after this long are leftovers of failed or superseded changes. */
const LEFTOVER_AGE_MS = 10 * 60 * 1000;

/** The file's own signature must match the declared type. */
export function sniffLogo(bytes: Uint8Array): Ext | null {
  const at = (i: number, ...v: number[]) => v.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

function storageFailure(error: { message?: string; statusCode?: string; status?: number } | null): ApiError {
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  if (status === 401 || status === 403 || /row-level security|unauthori[sz]ed|not authori[sz]ed/i.test(error?.message ?? "")) {
    return forbidden();
  }
  return new ApiError(502, "storage_failed", "The logo could not be stored. Try again.");
}

async function currentLogoPath(scope: DataScope): Promise<string | null> {
  const row = check(
    await scope.supabase.from("workspace_settings").select("logo_path")
      .eq("workspace_id", activeWorkspaceId(scope)).maybeSingle()
  ) as { logo_path: string | null } | null;
  return row?.logo_path ?? null;
}

export async function signedLogo(scope: DataScope): Promise<{ url: string; expiresAt: string } | null> {
  const path = await currentLogoPath(scope);
  if (!path) return null;
  const { data, error } = await scope.supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error && /not.?found/i.test(error.message ?? "")) return null;
  if (error || !data?.signedUrl) throw storageFailure(error);
  return { url: data.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString() };
}

/** Records `path` (or no logo) and returns the previous path. */
async function swapLogo(scope: DataScope, path: string | null): Promise<string | null> {
  const r = check(await scope.supabase.rpc("set_workspace_logo", { p_path: path })) as { previous: string | null } | null;
  return r?.previous ?? null;
}

/**
 * Best effort: removes `paths` and logo objects of this workspace that are not the current logo and are
 * old enough not to be an upload still waiting for its swap. A failure only leaves a private leftover.
 */
async function removeLeftovers(scope: DataScope, paths: (string | null)[], current: string | null): Promise<void> {
  const ws = activeWorkspaceId(scope);
  const bucket = scope.supabase.storage.from(BUCKET);
  const listed = await bucket.list(ws, { limit: 100, search: "logo" }).catch(() => ({ data: null }));
  const cutoff = Date.now() - LEFTOVER_AGE_MS;
  const stale = (listed.data ?? [])
    .filter((o) => LOGO_NAME.test(o.name) && Date.parse(String(o.created_at ?? "")) < cutoff)
    .map((o) => `${ws}/${o.name}`);
  const remove = [...new Set([...paths, ...stale])].filter((p): p is string => Boolean(p) && p !== current);
  if (remove.length) await bucket.remove(remove).catch(() => undefined);
}

export async function putLogo(scope: DataScope, contentType: string, bytes: Uint8Array | null) {
  const ext = TYPES[contentType as keyof typeof TYPES];
  if (!ext) throw invalid({ file: "Use a PNG, JPEG, or WebP image" });
  if (!bytes || bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw invalid({ file: "The image must be under 2 MB" });
  if (sniffLogo(bytes) !== ext) throw invalid({ file: "The file is not a valid image of that type" });
  const path = `${activeWorkspaceId(scope)}/logo-${randomUUID()}.${ext}`;
  const bucket = scope.supabase.storage.from(BUCKET);
  const { error } = await bucket.upload(path, bytes, { contentType, upsert: false, cacheControl: "60" });
  if (error) throw storageFailure(error);
  let previous: string | null;
  try {
    previous = await swapLogo(scope, path);
  } catch (err) {
    await bucket.remove([path]).catch(() => undefined);
    throw err;
  }
  await removeLeftovers(scope, [previous], path);
  return signedLogo(scope);
}

export async function deleteLogo(scope: DataScope): Promise<void> {
  const previous = await swapLogo(scope, null);
  await removeLeftovers(scope, [previous], null);
}

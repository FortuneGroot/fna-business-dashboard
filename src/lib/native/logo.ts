import "server-only";
import { ApiError, check, forbidden, invalid } from "@/lib/api/native";
import { activeWorkspaceId, type DataScope } from "@/lib/data/query";

/* Workspace logo (spec §6.6): private bucket `workspace-assets`, object `{workspace_id}/logo.{ext}`,
 * served through short-lived signed URLs. Every call uses the member's own JWT, so the Storage
 * policies (settings.read / settings.write in the active workspace) decide; the route checks the
 * same permissions first. Platform admins change logos through the audited platform endpoint. */

const BUCKET = "workspace-assets";
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const SIGNED_URL_SECONDS = 300;
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
type Ext = (typeof TYPES)[keyof typeof TYPES];
const LOGO_NAME = /^logo\.(png|jpg|webp)$/;

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

async function logoNames(scope: DataScope): Promise<string[]> {
  const ws = activeWorkspaceId(scope);
  const { data, error } = await scope.supabase.storage.from(BUCKET).list(ws, { limit: 20, search: "logo." });
  if (error) throw storageFailure(error);
  return (data ?? [])
    .filter((o) => LOGO_NAME.test(o.name))
    .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
    .map((o) => `${ws}/${o.name}`);
}

export async function signedLogo(scope: DataScope): Promise<{ url: string; expiresAt: string } | null> {
  const [path] = await logoNames(scope);
  if (!path) return null;
  const { data, error } = await scope.supabase.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw storageFailure(error);
  return { url: data.signedUrl, expiresAt: new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString() };
}

async function setLogoPath(scope: DataScope, path: string | null): Promise<void> {
  const row = check(
    await scope.supabase.from("workspace_settings").update({ logo_path: path })
      .eq("workspace_id", activeWorkspaceId(scope)).select("workspace_id").maybeSingle()
  );
  if (!row) throw forbidden();
}

export async function putLogo(scope: DataScope, contentType: string, bytes: Uint8Array) {
  const ext = TYPES[contentType as keyof typeof TYPES];
  if (!ext) throw invalid({ file: "Use a PNG, JPEG, or WebP image" });
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw invalid({ file: "The image must be under 2 MB" });
  if (sniffLogo(bytes) !== ext) throw invalid({ file: "The file is not a valid image of that type" });
  const ws = activeWorkspaceId(scope);
  const path = `${ws}/logo.${ext}`;
  const { error } = await scope.supabase.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true, cacheControl: "60" });
  if (error) throw storageFailure(error);
  const stale = (await logoNames(scope)).filter((p) => p !== path);
  if (stale.length) {
    const removed = await scope.supabase.storage.from(BUCKET).remove(stale);
    if (removed.error) throw storageFailure(removed.error);
  }
  await setLogoPath(scope, path);
  return signedLogo(scope);
}

export async function deleteLogo(scope: DataScope): Promise<void> {
  const names = await logoNames(scope);
  if (names.length) {
    const removed = await scope.supabase.storage.from(BUCKET).remove(names);
    if (removed.error) throw storageFailure(removed.error);
  }
  await setLogoPath(scope, null);
}

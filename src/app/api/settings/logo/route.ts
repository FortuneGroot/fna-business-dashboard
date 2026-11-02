import type { NextRequest } from "next/server";
import { invalid, nativeApi } from "@/lib/api/native";
import { readLimitedBody } from "@/lib/http/limited-body";
import { MAX_LOGO_BYTES, deleteLogo, putLogo, signedLogo } from "@/lib/native/logo";

export const dynamic = "force-dynamic";

/** GET: a short-lived signed URL for the active workspace's logo, or null (§6.6). */
export async function GET(req: NextRequest) {
  return nativeApi(req, { permission: "settings.read" }, async (scope) => ({ logo: await signedLogo(scope) }));
}

/** PUT: the raw image as the body, with its Content-Type (PNG, JPEG, or WebP, under 2 MB). */
export async function PUT(req: NextRequest) {
  return nativeApi(req, { permission: "settings.write" }, async (scope) => {
    const contentType = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const bytes = await readLimitedBody(req, MAX_LOGO_BYTES);
    if (!bytes) throw invalid({ file: "The image must be under 2 MB" });
    return { logo: await putLogo(scope, contentType, bytes) };
  });
}

export async function DELETE(req: NextRequest) {
  return nativeApi(req, { permission: "settings.write" }, async (scope) => {
    await deleteLogo(scope);
    return { logo: null };
  });
}

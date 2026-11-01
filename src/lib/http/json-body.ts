/**
 * True when the request declares a JSON body. `text/plain` and form types are CORS-simple, so a
 * cross-site page could send them without a preflight; JSON endpoints refuse them.
 */
export function isJsonRequest(req: Request): boolean {
  const mediaType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mediaType);
}

/**
 * Reads a JSON request body that must be a plain object. Returns null for a non-JSON content type,
 * invalid JSON, and for `null`, arrays, strings, numbers, and booleans, so handlers never dereference
 * a non-object.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  if (!isJsonRequest(req)) return null;
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

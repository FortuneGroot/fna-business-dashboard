/**
 * Reads a JSON request body that must be a plain object. Returns null for invalid JSON and for
 * `null`, arrays, strings, numbers, and booleans, so handlers never dereference a non-object.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

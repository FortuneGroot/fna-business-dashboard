import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authProvider } from "@/lib/auth/provider";
import { DataUnavailableError, type DataScope } from "@/lib/data/query";
import { isJsonRequest } from "@/lib/http/json-body";

/** A §7.1 error: `{ ok: false, error, code[, fields] }` with its HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>
  ) {
    super(message);
  }
}

export const notFound = () => new ApiError(404, "not_found", "Not found");
export const forbidden = () => new ApiError(403, "forbidden", "Forbidden");
export const conflict = (message = "This change conflicts with the current state", code = "conflict") =>
  new ApiError(409, code, message);
export const invalid = (fields: Record<string, string>, message = "Some fields are invalid") =>
  new ApiError(422, "validation_failed", message, fields);

export function errorResponse(err: ApiError): NextResponse {
  return NextResponse.json(
    { ok: false, error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) },
    { status: err.status, headers: { "Cache-Control": "private, no-store" } }
  );
}

const INVITATION_GONE = new Set(["invitation_expired", "invitation_used", "invitation_revoked"]);
const INVITATION_MESSAGES: Record<string, string> = {
  invitation_expired: "This invitation has expired. Ask for a new one.",
  invitation_used: "This invitation has already been used.",
  invitation_revoked: "This invitation was revoked.",
  invitation_not_found: "This invitation link is not valid.",
  invitation_email_mismatch: "This invitation was sent to a different email address.",
  invitation_email_unverified: "Confirm your email address first, then open this invitation again.",
};

/** PostgREST refusals of the JWT itself (expired, invalid) and M21's ended-session check. */
const SESSION_REFUSALS = new Set(["PGRST301", "PGRST302", "PGRST303", "PT401"]);
/** Serialization failure and deadlock: the transaction was rolled back and can simply be retried. */
const RETRYABLE = new Set(["40001", "40P01"]);

type DbError = { message?: string; code?: string; status?: number } | null | undefined;

/**
 * Maps a PostgREST/RPC failure to a §7.1 error. Database functions raise stable codes as messages
 * (M11); SQLSTATEs cover constraint and RLS failures. Anything unrecognised (network errors,
 * 5xx) is reported as 503 `unavailable`, never as a client error.
 */
export function dbFailure(error: DbError): ApiError {
  const message = error?.message ?? "";
  const code = error?.code ?? "";
  if (INVITATION_GONE.has(message)) return new ApiError(410, message, INVITATION_MESSAGES[message]);
  if (message === "invitation_not_found") return new ApiError(404, message, INVITATION_MESSAGES[message]);
  if (message === "invitation_email_mismatch" || message === "invitation_email_unverified") {
    return new ApiError(403, message, INVITATION_MESSAGES[message]);
  }
  if (SESSION_REFUSALS.has(code) || message === "session_ended") {
    return new ApiError(401, "unauthenticated", "Your session has ended. Sign in again.");
  }
  if (RETRYABLE.has(code)) {
    return conflict("This change collided with another one made at the same moment. Nothing was saved; try again.", "retry");
  }
  if (message === "logo_missing") return conflict("The logo was changed at the same moment. Reload and try again.");
  if (message === "already_member") return conflict("This person is already a member of the workspace", "already_member");
  if (message === "workspace_suspended") return new ApiError(423, "workspace_suspended", "This workspace is suspended");
  if (message === "forbidden" || code === "42501") return forbidden();
  if (message === "not_found" || code === "P0002") return notFound();
  if (message === "validation_failed" || ["22023", "22P02", "22001", "22007", "22008", "23502"].includes(code)) {
    return invalid({}, "The request was rejected as invalid");
  }
  if (code === "23514" && /at least one active owner/.test(message)) {
    return conflict("A workspace must keep at least one active owner", "last_owner");
  }
  if (code === "23514") return invalid({}, "The request was rejected as invalid");
  if (code === "23503") return invalid({}, "A referenced record does not exist in this workspace or is not an active member");
  if (code === "23P01") return conflict("This time overlaps another booking on the same calendar", "overlap");
  if (message === "conflict" || code === "23505") return conflict();
  console.error(`[native-api] unmapped database failure: code=${code || "none"} status=${error?.status ?? "none"}`);
  return new ApiError(503, "unavailable", "Service temporarily unavailable");
}

/** Throws the mapped error when a PostgREST call failed. */
export function check<T>(res: { data: T; error: DbError }): T {
  if (res.error) throw dbFailure(res.error);
  return res.data;
}

const IGNORED_KEYS = new Set(["workspaceId", "workspace_id"]);

function fieldsOf(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "body";
    fields[key] ??= issue.message;
  }
  return fields;
}

/**
 * Parses a JSON object body against a strict schema. Workspace keys are dropped first (ISO-F1: the
 * workspace always comes from the request context); any other unknown key is rejected. The body must
 * be declared as JSON (`isJsonRequest`).
 */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  if (!isJsonRequest(req)) throw invalid({ body: "Request body must be sent as application/json" });
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw invalid({ body: "Request body must be valid JSON" });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid({ body: "Request body must be a JSON object" });
  }
  const cleaned = Object.fromEntries(Object.entries(value).filter(([k]) => !IGNORED_KEYS.has(k)));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) throw invalid(fieldsOf(parsed.error));
  return parsed.data;
}

/** Parses query parameters (first value of each, workspace keys dropped) against a strict schema. */
export function parseQuery<S extends z.ZodType>(req: NextRequest, schema: S): z.infer<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of req.nextUrl.searchParams) {
    if (!IGNORED_KEYS.has(k) && !(k in raw)) raw[k] = v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(fieldsOf(parsed.error));
  return parsed.data;
}

/** Any 8-4-4-4-12 hex id (Postgres uuid syntax; not limited to RFC variants). */
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Must be a UUID");

/** Route `[id]` segments: anything but a UUID is 422 (§7.1). */
export function parseId(value: string, name = "id"): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw invalid({ [name]: "Must be a UUID" });
  return parsed.data.toLowerCase();
}

/**
 * Origin for links handed to the user (invite URLs). `APP_ORIGIN` (server-only) pins it in deployed
 * environments; otherwise it is the request's own host, so the link matches the address the inviter
 * is using. `req.nextUrl` is not used: `next start` reports its bind hostname there, not the Host.
 */
export function appOrigin(req: NextRequest): string {
  const pinned = process.env.APP_ORIGIN;
  if (pinned) {
    try {
      const url = new URL(pinned);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // fall through
    }
    throw new ApiError(503, "unavailable", "Service temporarily unavailable");
  }
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  const proto = (req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(/:$/, "")).split(",")[0].trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) || !/^https?$/.test(proto)) return req.nextUrl.origin;
  return `${proto}://${host}`;
}

/** §7.1 pagination: `limit` ≤ 100 (default 50) and an opaque `cursor`. */
export const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
};

export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Decodes a cursor produced by encodeCursor; a malformed one is 422, never a 500. */
export function decodeCursor<S extends z.ZodType>(cursor: string | undefined, schema: S): z.infer<S> | null {
  if (!cursor) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw invalid({ cursor: "Invalid cursor" });
}

export type NativeOptions = {
  /** Required permission in the active workspace (checked here and again by RLS / the RPC). */
  permission?: string;
  /** Re-check the session with the Auth server first (§5.1), for membership and invitation changes. */
  sensitive?: boolean;
};

/**
 * Shared handler for native-only APIs (§7.4). Requires AUTH_PROVIDER=supabase (404 otherwise, so
 * legacy mode is unchanged), a valid session and active workspace, and `permission`; runs `run`
 * with the caller's own JWT; maps failures to §7.1 errors; applies refreshed session cookies.
 */
export async function nativeApi(
  req: NextRequest,
  options: NativeOptions,
  run: (scope: DataScope) => Promise<Record<string, unknown>>
): Promise<NextResponse> {
  if (authProvider() !== "supabase") return errorResponse(notFound());
  const { requireApiContext, sessionStillValid, denialResponse } = await import("@/lib/authz/context");
  const { applyPendingCookies } = await import("@/lib/supabase/server");
  const { ctx, supabase, pending, error } = await requireApiContext(req, { permission: options.permission });
  if (error) return error;
  const reply = (res: NextResponse) => applyPendingCookies(res, pending);
  try {
    if (options.sensitive && !(await sessionStillValid(supabase!, ctx!))) return reply(denialResponse("unauthenticated"));
    const body = await run({ supabase: supabase!, ctx: ctx! });
    return reply(NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "private, no-store" } }));
  } catch (err) {
    if (err instanceof ApiError) return reply(errorResponse(err));
    if (err instanceof DataUnavailableError) return reply(errorResponse(new ApiError(503, "unavailable", "Service temporarily unavailable")));
    throw err;
  }
}

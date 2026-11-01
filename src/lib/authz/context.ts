import "server-only";
import * as React from "react";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expireAuthCookies, supabaseAuthConfig } from "@/lib/auth/provider";
import {
  applyPendingCookies,
  supabaseForRequest,
  supabaseForServerComponent,
  type PendingCookies,
} from "@/lib/supabase/server";
import {
  contextFromRpc,
  denialRedirect,
  evaluateContext,
  type ContextDenial,
  type ContextRequirement,
  type RequestContext,
  type WorkspaceRole,
  type WorkspaceStatus,
} from "./evaluate";

export { evaluateContext, legacyRoleOf } from "./evaluate";
export type { ContextDenial, ContextRequirement, RequestContext, WorkspaceRole, WorkspaceStatus } from "./evaluate";

export class AuthMisconfiguredError extends Error {
  constructor() {
    super("Supabase authentication is not configured");
  }
}

export class ContextUnavailableError extends Error {}

// React `cache` exists in the server-component React bundled by Next; plain Node (tests) has no
// request scope to cache in, so the function runs uncached there.
type AnyFn = (...args: never[]) => unknown;
const cache: <T extends AnyFn>(fn: T) => T = (React as { cache?: <T extends AnyFn>(fn: T) => T }).cache ?? ((fn) => fn);

/**
 * Verifies the session JWT (getClaims) and loads the database request context with the user's own
 * JWT. Returns null when there is no valid session. Throws ContextUnavailableError when the database
 * cannot answer, so outages are not reported as signed-out.
 */
export async function loadRequestContext(supabase: SupabaseClient): Promise<RequestContext | null> {
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (claimsError || !claims?.sub) return null;

  const res = await supabase.rpc("request_context");
  if (res.status === 401 || res.status === 403) return null;
  if (res.error) throw new ContextUnavailableError("request context unavailable");
  return contextFromRpc(res.data, claims as Record<string, unknown>);
}

const DENIAL_HTTP: Record<ContextDenial, [number, string]> = {
  unauthenticated: [401, "Unauthorized"],
  no_active_workspace: [403, "No active workspace"],
  workspace_suspended: [423, "This workspace is suspended"],
  forbidden: [403, "Forbidden"],
};

export function denialResponse(denial: ContextDenial): NextResponse {
  const [status, error] = DENIAL_HTTP[denial];
  return NextResponse.json({ ok: false, error, code: denial }, { status });
}

export function misconfiguredResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Authentication misconfigured", code: "auth_misconfigured" },
    { status: 503 }
  );
}

export function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "Service temporarily unavailable", code: "unavailable" },
    { status: 503 }
  );
}

export type ApiContext = {
  ctx: RequestContext | null;
  supabase: SupabaseClient | null;
  pending: PendingCookies;
  error: NextResponse | null;
};

/**
 * API variant of requireContext: returns a typed error response instead of redirecting. Session
 * cookie changes made while loading the context (refresh, sign-out) are already applied to `error`;
 * handlers must apply `pending` to every other response they return.
 */
export async function requireApiContext(req: NextRequest, requirement: ContextRequirement = {}): Promise<ApiContext> {
  const config = supabaseAuthConfig();
  const empty: PendingCookies = { cookies: [], headers: {} };
  if (!config) return { ctx: null, supabase: null, pending: empty, error: misconfiguredResponse() };
  const { supabase, pending } = supabaseForRequest(req.headers.get("cookie"), config);
  let ctx: RequestContext | null;
  try {
    ctx = await loadRequestContext(supabase);
  } catch {
    return { ctx: null, supabase, pending, error: applyPendingCookies(unavailableResponse(), pending) };
  }
  const denial = evaluateContext(ctx, requirement);
  if (denial === "unauthenticated") {
    const error = applyPendingCookies(denialResponse(denial), pending);
    return { ctx, supabase, pending, error: expireAuthCookies(error, req.cookies.getAll().map((c) => c.name)) };
  }
  if (denial) return { ctx, supabase, pending, error: applyPendingCookies(denialResponse(denial), pending) };
  if (!requirement.allowNoWorkspace && workspaceChanged(req, ctx)) {
    return { ctx, supabase, pending, error: applyPendingCookies(workspaceChangedResponse(), pending) };
  }
  return { ctx, supabase, pending, error: null };
}

/**
 * Header naming the workspace a browser page was rendered for. It is a precondition only: the
 * workspace always comes from the session, and a mismatch is refused so a tab left open on another
 * business can neither show nor change the newly active one's records.
 */
export const EXPECTED_WORKSPACE_HEADER = "x-fna-workspace";

function workspaceChanged(req: NextRequest, ctx: RequestContext | null): boolean {
  const expected = req.headers.get(EXPECTED_WORKSPACE_HEADER)?.trim().toLowerCase();
  return Boolean(expected && ctx?.workspace && ctx.workspace.id.toLowerCase() !== expected);
}

function workspaceChangedResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "You switched to a different business in another tab. Reload this page to continue.",
      code: "workspace_changed",
    },
    { status: 409, headers: { "Cache-Control": "private, no-store" } }
  );
}

/**
 * Sensitive mutations re-check the session with the Auth server (getUser), so a revoked session is
 * refused before its JWT expires (§5.1).
 */
export async function sessionStillValid(supabase: SupabaseClient, ctx: RequestContext): Promise<boolean> {
  const { data, error } = await supabase.auth.getUser();
  return !error && data.user?.id === ctx.userId;
}

/** Request-scoped (React cache) Supabase client for server components, carrying the user's JWT. */
export const getPageSupabase = cache(async (): Promise<SupabaseClient> => {
  const config = supabaseAuthConfig();
  if (!config) throw new AuthMisconfiguredError();
  return supabaseForServerComponent(config);
});

/** Request-scoped (React cache) context for server components. */
export const getRequestContext = cache(async (): Promise<RequestContext | null> => {
  return loadRequestContext(await getPageSupabase());
});

export type WorkspaceListItem = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  role: WorkspaceRole | null;
  grantMode: "read" | "write" | null;
};

/** The signed-in user's memberships and live grants (rpc list_my_workspaces), for server components. */
export async function listMyWorkspacesForPage(): Promise<WorkspaceListItem[]> {
  const config = supabaseAuthConfig();
  if (!config) throw new AuthMisconfiguredError();
  const supabase = await supabaseForServerComponent(config);
  const res = await supabase.rpc("list_my_workspaces");
  if (res.error) return [];
  type Raw = Omit<WorkspaceListItem, "grantMode"> & { grant_mode: WorkspaceListItem["grantMode"] };
  return ((res.data as Raw[] | null) ?? []).map(({ grant_mode, ...w }) => ({ ...w, grantMode: grant_mode }));
}

/** Page variant: redirects to /login, /no-access, /workspace-suspended, or /dashboard?denied=1. */
export async function requirePageContext(requirement: ContextRequirement = {}): Promise<RequestContext> {
  let ctx: RequestContext | null;
  try {
    ctx = await getRequestContext();
  } catch (err) {
    if (err instanceof AuthMisconfiguredError) redirect("/login?error=auth_misconfigured");
    throw err;
  }
  const denial = evaluateContext(ctx, requirement);
  if (denial) redirect(denialRedirect(denial, ctx));
  return ctx!;
}

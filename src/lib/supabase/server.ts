import "server-only";
import { createServerClient, parseCookieHeader, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { supabaseCookieOptions, type SupabaseAuthConfig } from "@/lib/auth/provider";

export type PendingCookies = {
  cookies: { name: string; value: string; options: CookieOptions }[];
  headers: Record<string, string>;
};

/**
 * Per-request client for route handlers, built from the request's Cookie header. Cookie writes
 * (sign-in, refresh, sign-out) are collected so the handler can apply them to its own response.
 * Never cached or shared across requests.
 */
export function supabaseForRequest(
  cookieHeader: string | null,
  config: SupabaseAuthConfig
): { supabase: SupabaseClient; pending: PendingCookies } {
  const pending: PendingCookies = { cookies: [], headers: {} };
  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll: () =>
        parseCookieHeader(cookieHeader ?? "").map((c) => ({ name: c.name, value: c.value ?? "" })),
      setAll(list, headers) {
        pending.cookies.push(...list);
        Object.assign(pending.headers, headers ?? {});
      },
    },
  });
  return { supabase, pending };
}

/** Per-request anonymous client (no session) for the public invitation preview. */
export function supabaseAnonymous(config: SupabaseAuthConfig): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function applyPendingCookies(res: NextResponse, pending: PendingCookies): NextResponse {
  for (const c of pending.cookies) res.cookies.set(c.name, c.value, c.options);
  for (const [k, v] of Object.entries(pending.headers)) res.headers.set(k, v);
  return res;
}

/**
 * Per-request client for server components. Server components cannot write cookies; middleware
 * refreshes the session before rendering, so writes here are dropped.
 */
export async function supabaseForServerComponent(config: SupabaseAuthConfig): Promise<SupabaseClient> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return createServerClient(config.url, config.anonKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
      setAll() {
        /* read-only in server components */
      },
    },
  });
}

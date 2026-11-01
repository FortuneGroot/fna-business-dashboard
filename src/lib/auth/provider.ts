/**
 * Authentication provider switch (spec §5.2). `legacy` (default) keeps the env-credential
 * `fna_session` flow untouched; `supabase` uses Supabase Auth sessions and the database request
 * context. Any other value is a misconfiguration and protected routes fail closed.
 * Edge-safe: imported by middleware.
 */
export type AuthProvider = "legacy" | "supabase";

export function authProvider(env: NodeJS.ProcessEnv = process.env): AuthProvider | null {
  const raw = (env.AUTH_PROVIDER || "").trim().toLowerCase();
  if (raw === "" || raw === "legacy") return "legacy";
  if (raw === "supabase") return "supabase";
  return null;
}

export type SupabaseAuthConfig = { url: string; anonKey: string };

/** Session cookies are only read by the server, so they are httpOnly (same policy as fna_session). */
export function supabaseCookieOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: env.NODE_ENV === "production" || env.VERCEL_ENV === "production",
  };
}

/**
 * Server-side Supabase Auth settings: SUPABASE_URL plus the anon (publishable) key. The browser never
 * talks to Supabase directly, so no NEXT_PUBLIC_* variables are used. Returns null when incomplete.
 */
export function supabaseAuthConfig(env: NodeJS.ProcessEnv = process.env): SupabaseAuthConfig | null {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const anonKey = (env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  if (!url || !anonKey) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { url, anonKey };
}

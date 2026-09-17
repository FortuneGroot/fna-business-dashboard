/**
 * Edge-safe session cookie checks for middleware (Web Crypto).
 * Cookie body is { sid, exp }. Durable activity is confirmed against auth_sessions
 * using the same id / revoked / expires_at columns as the Node session store.
 */
import { AUTH_COOKIE } from "./types";

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacSign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export type EdgeTokenOk = { sid: string; exp: number };

function supabaseRestConfig(env: Record<string, string | undefined>): {
  url: string;
  key: string;
} | null {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key || !url.startsWith("http")) return null;
  return { url, key };
}

/**
 * Durable revocation check for Edge middleware.
 * When Supabase is configured, a signed cookie is never trusted without a live row:
 *   revoked = false AND expires_at > now
 * Never logs session IDs or secrets.
 */
export async function isStoredSessionActiveEdge(
  sid: string,
  nowSec = Math.floor(Date.now() / 1000),
  env: Record<string, string | undefined> = process.env
): Promise<boolean> {
  if (!sid || !/^[a-f0-9]{32,}$/i.test(sid)) return false;

  const cfg = supabaseRestConfig(env);
  if (!cfg) {
    // Durable store expected on Preview/Production — never fail open there.
    const vercelEnv = (env.VERCEL_ENV || "").trim().toLowerCase();
    if (vercelEnv === "production" || vercelEnv === "preview") return false;
    if ((env.AUTH_FAIL_CLOSED || "").trim().toLowerCase() === "true") return false;
    // Local/dev without Supabase: allow signature-only (memory sessions).
    return true;
  }

  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/auth_sessions?id=eq.${encodeURIComponent(sid)}&select=id,expires_at,revoked&limit=1`,
      {
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
          Accept: "application/json",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as Array<{
      id?: string;
      expires_at?: string;
      revoked?: boolean;
    }>;
    const row = rows[0];
    if (!row?.id || row.id !== sid || row.revoked === true) return false;
    const expiresAt = Math.floor(new Date(String(row.expires_at || "")).getTime() / 1000);
    return Number.isFinite(expiresAt) && expiresAt >= nowSec;
  } catch {
    return false;
  }
}

export async function verifySessionTokenEdge(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<EdgeTokenOk | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = await hmacSign(body, secret);
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const pad = body.length % 4 === 0 ? "" : "=".repeat(4 - (body.length % 4));
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const json = JSON.parse(atob(b64)) as { sid?: string; exp?: number };
    if (!json.sid || !json.exp || json.exp < nowSec) return null;
    if (!/^[a-f0-9]{32,}$/i.test(json.sid)) return null;
    return { sid: json.sid, exp: json.exp };
  } catch {
    return null;
  }
}

export function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export { AUTH_COOKIE };

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AUTH_COOKIE,
  SESSION_TTL_SECONDS,
  type SessionPayload,
  type SessionUser,
  isAuthRole,
} from "./types";
import { passwordsMatch } from "./password";
import {
  createStoredSession,
  getStoredSession,
  revokeStoredSession,
} from "./session-store";

export { AUTH_COOKIE, SESSION_TTL_SECONDS };
export type { SessionPayload, SessionUser };

export function getAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AUTH_SECRET || "").trim();
}

/**
 * Auth enforcement policy:
 * - AUTH_SECRET set → sessions enforced
 * - VERCEL_ENV=production without AUTH_SECRET → fail closed
 * - AUTH_FAIL_CLOSED=true → fail closed
 * - AUTH_DEV_OPEN=true (non-production only) → allow open without secret
 * - otherwise non-production without secret → open (Preview behind Vercel Protection)
 */
export function isAuthEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getAuthSecret(env));
}

export function isAuthFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (getAuthSecret(env)) return true;
  const vercelEnv = (env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercelEnv === "production") return true;
  if ((env.AUTH_FAIL_CLOSED || "").toLowerCase() === "true") return true;
  return false;
}

export function mustProtectRoutes(env: NodeJS.ProcessEnv = process.env): boolean {
  if (getAuthSecret(env)) return true;
  if (isAuthFailClosed(env)) return true;
  return false;
}

type Cred = SessionUser & { password: string };

function loadConfiguredUsers(env: NodeJS.ProcessEnv = process.env): Cred[] {
  const out: Cred[] = [];
  const triples: Array<[string, string, import("./types").AuthRole, string]> = [
    [
      (env.AUTH_OWNER_EMAIL || "").trim(),
      (env.AUTH_OWNER_PASSWORD || "").trim(),
      "OWNER",
      (env.AUTH_OWNER_NAME || "Owner").trim(),
    ],
    [
      (env.AUTH_ADMIN_EMAIL || "").trim(),
      (env.AUTH_ADMIN_PASSWORD || "").trim(),
      "ADMIN",
      (env.AUTH_ADMIN_NAME || "Admin").trim(),
    ],
    [
      (env.AUTH_CLIENT_EMAIL || "").trim(),
      (env.AUTH_CLIENT_PASSWORD || "").trim(),
      "CLIENT",
      (env.AUTH_CLIENT_NAME || "Client").trim(),
    ],
  ];
  for (const [email, password, role, name] of triples) {
    if (email && password) out.push({ email: email.toLowerCase(), password, role, name });
  }
  return out;
}

export function authenticateCredentials(
  email: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env
): SessionUser | null {
  const users = loadConfiguredUsers(env);
  const normalized = email.trim().toLowerCase();
  let matched: SessionUser | null = null;
  for (const u of users) {
    // Always run a password compare to reduce timing variance across configured users.
    const passOk = passwordsMatch(password, u.password);
    if (u.email === normalized && passOk) {
      matched = { email: u.email, role: u.role, name: u.name };
    }
  }
  return matched;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

type TokenBody = { sid: string; exp: number };

export async function createSessionToken(
  user: SessionUser,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<string> {
  const stored = await createStoredSession(user, env, nowSec);
  const payload: TokenBody = { sid: stored.id, exp: stored.expiresAt };
  const body = b64url(JSON.stringify(payload));
  const sig = signBody(body, secret);
  return `${body}.${sig}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = signBody(body, secret);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let parsed: TokenBody;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenBody;
  } catch {
    return null;
  }
  if (!parsed.sid || !parsed.exp || parsed.exp < nowSec) return null;
  const stored = await getStoredSession(parsed.sid, env, nowSec);
  if (!stored) return null;
  if (!isAuthRole(stored.role)) return null;
  return {
    email: stored.email,
    role: stored.role,
    name: stored.name,
    iat: stored.createdAt,
    exp: stored.expiresAt,
    sid: stored.id,
  };
}

export async function revokeSessionToken(
  token: string,
  secret: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const parts = token.split(".");
  if (parts.length !== 2) return;
  const [body, sig] = parts;
  if (!body || !sig) return;
  const expected = signBody(body, secret);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return;
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenBody;
    if (parsed.sid) await revokeStoredSession(parsed.sid, env);
  } catch {
    /* ignore */
  }
}

export async function readSessionFromCookieHeader(
  cookieHeader: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<SessionPayload | null> {
  const secret = getAuthSecret(env);
  if (!secret || !cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  if (!match) return null;
  try {
    return await verifySessionToken(decodeURIComponent(match[1]), secret, env);
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

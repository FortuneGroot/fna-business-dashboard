import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AUTH_COOKIE,
  SESSION_TTL_SECONDS,
  type AuthRole,
  type SessionPayload,
  type SessionUser,
  isAuthRole,
} from "./types";

export { AUTH_COOKIE, SESSION_TTL_SECONDS };
export type { AuthRole, SessionPayload, SessionUser };

export function getAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AUTH_SECRET || "").trim();
}

export function isAuthEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(getAuthSecret(env));
}

type Cred = SessionUser & { password: string };

function loadConfiguredUsers(env: NodeJS.ProcessEnv = process.env): Cred[] {
  const out: Cred[] = [];
  const triples: Array<[string, string, AuthRole, string]> = [
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
  const match = users.find((u) => u.email === normalized && u.password === password);
  if (!match) return null;
  return { email: match.email, role: match.role, name: match.name };
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b.toString("base64url");
}

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function createSessionToken(
  user: SessionUser,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): string {
  const payload: SessionPayload = {
    email: user.email,
    role: user.role,
    name: user.name,
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SECONDS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = signBody(body, secret);
  return `${body}.${sig}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): SessionPayload | null {
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
  try {
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!json.email || !isAuthRole(json.role) || !json.exp) return null;
    if (json.exp < nowSec) return null;
    return json;
  } catch {
    return null;
  }
}

export function readSessionFromCookieHeader(
  cookieHeader: string | null,
  env: NodeJS.ProcessEnv = process.env
): SessionPayload | null {
  const secret = getAuthSecret(env);
  if (!secret || !cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
  if (!match) return null;
  try {
    return verifySessionToken(decodeURIComponent(match[1]), secret);
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

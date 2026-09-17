import { randomBytes } from "node:crypto";
import type { AuthRole, SessionUser } from "./types";
import { SESSION_TTL_SECONDS } from "./types";
import { isSupabaseConfigured } from "@/lib/sync/db-client";

export type StoredSession = {
  id: string;
  email: string;
  role: AuthRole;
  name: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
};

const GLOBAL_KEY = "__fna_auth_sessions__";

type GlobalSessions = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, StoredSession>;
};

function memoryMap(): Map<string, StoredSession> {
  const g = globalThis as GlobalSessions;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

async function supabaseUpsert(session: StoredSession, env: NodeJS.ProcessEnv): Promise<void> {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/auth_sessions`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      id: session.id,
      email: session.email,
      role: session.role,
      name: session.name,
      created_at: new Date(session.createdAt * 1000).toISOString(),
      expires_at: new Date(session.expiresAt * 1000).toISOString(),
      revoked: session.revoked,
    }),
  }).catch(() => undefined);
}

async function supabaseGet(
  id: string,
  env: NodeJS.ProcessEnv
): Promise<StoredSession | null> {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  const res = await fetch(
    `${url}/rest/v1/auth_sessions?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email || ""),
    role: String(row.role || "CLIENT") as AuthRole,
    name: String(row.name || ""),
    createdAt: Math.floor(new Date(String(row.created_at)).getTime() / 1000),
    expiresAt: Math.floor(new Date(String(row.expires_at)).getTime() / 1000),
    revoked: Boolean(row.revoked),
  };
}

async function supabaseRevoke(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/auth_sessions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ revoked: true }),
  }).catch(() => undefined);
}

export function createSessionId(): string {
  return randomBytes(24).toString("base64url");
}

export async function createStoredSession(
  user: SessionUser,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<StoredSession> {
  const session: StoredSession = {
    id: createSessionId(),
    email: user.email,
    role: user.role,
    name: user.name,
    createdAt: nowSec,
    expiresAt: nowSec + SESSION_TTL_SECONDS,
    revoked: false,
  };
  memoryMap().set(session.id, session);
  if (isSupabaseConfigured(env)) {
    await supabaseUpsert(session, env);
  }
  return session;
}

export async function getStoredSession(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<StoredSession | null> {
  if (!id) return null;
  let session = memoryMap().get(id) || null;
  if (!session && isSupabaseConfigured(env)) {
    session = await supabaseGet(id, env);
    if (session) memoryMap().set(session.id, session);
  }
  if (!session) return null;
  if (session.revoked) return null;
  if (session.expiresAt < nowSec) {
    session.revoked = true;
    memoryMap().set(session.id, session);
    return null;
  }
  return session;
}

export async function revokeStoredSession(
  id: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!id) return;
  const existing = memoryMap().get(id);
  if (existing) {
    existing.revoked = true;
    memoryMap().set(id, existing);
  } else {
    memoryMap().set(id, {
      id,
      email: "",
      role: "CLIENT",
      name: "",
      createdAt: 0,
      expiresAt: 0,
      revoked: true,
    });
  }
  if (isSupabaseConfigured(env)) {
    await supabaseRevoke(id, env);
  }
}

export function resetAuthSessionsForTests(): void {
  memoryMap().clear();
}

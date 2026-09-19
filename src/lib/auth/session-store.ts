import { randomBytes } from "node:crypto";
import type { AuthRole, SessionUser } from "./types";
import { SESSION_TTL_SECONDS } from "./types";
import { isSupabaseConfigured } from "@/lib/sync/db-client";
import { supabaseRestAuthHeaders } from "@/lib/sync/supabase-rest-auth";

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

/** Hex-only IDs — safe in cookies and PostgREST filters (no base64url punctuation). */
export function createSessionId(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Memory sessions are development/test only.
 * Never used as auth fallback when Supabase is configured (Preview/Production).
 */
export function allowMemorySessionFallback(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (isSupabaseConfigured(env)) return false;
  const vercelEnv = (env.VERCEL_ENV || "").trim().toLowerCase();
  if (vercelEnv === "production" || vercelEnv === "preview") return false;
  if ((env.AUTH_ALLOW_MEMORY_SESSIONS || "").toLowerCase() === "true") return true;
  // Local/unit tests without Supabase.
  return vercelEnv === "" || vercelEnv === "development";
}

function supabaseRestConfig(env: NodeJS.ProcessEnv): { url: string; key: string } | null {
  const url = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key || !url.startsWith("http")) return null;
  return { url, key };
}

/**
 * Persist session and confirm the row is readable.
 * Throws on any durable-store failure — callers must not issue cookies.
 * Never logs secrets, cookies, or session IDs.
 */
async function supabaseUpsertConfirmed(
  session: StoredSession,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const cfg = supabaseRestConfig(env);
  if (!cfg) throw new Error("Durable session store is not configured");

  const upsertRes = await fetch(
    `${cfg.url}/rest/v1/auth_sessions?on_conflict=id`,
    {
      method: "POST",
      headers: {
        ...supabaseRestAuthHeaders(cfg.key),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
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
    }
  );

  if (!upsertRes.ok) {
    throw new Error(`Durable session write failed (HTTP ${upsertRes.status})`);
  }

  // Confirm the exact id is readable with the same query shape Edge middleware uses.
  const confirm = await supabaseGet(session.id, env);
  if (!confirm || confirm.revoked || confirm.id !== session.id) {
    throw new Error("Durable session write could not be confirmed");
  }
}

async function supabaseGet(
  id: string,
  env: NodeJS.ProcessEnv
): Promise<StoredSession | null> {
  const cfg = supabaseRestConfig(env);
  if (!cfg) return null;
  const res = await fetch(
    `${cfg.url}/rest/v1/auth_sessions?id=eq.${encodeURIComponent(id)}&select=id,email,role,name,created_at,expires_at,revoked&limit=1`,
    {
      headers: {
        ...supabaseRestAuthHeaders(cfg.key),
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );
  if (!res.ok) return null;
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
  const cfg = supabaseRestConfig(env);
  if (!cfg) throw new Error("Durable session store is not configured");
  const res = await fetch(
    `${cfg.url}/rest/v1/auth_sessions?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        ...supabaseRestAuthHeaders(cfg.key),
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ revoked: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`Durable session revoke failed (HTTP ${res.status})`);
  }
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

  if (isSupabaseConfigured(env)) {
    await supabaseUpsertConfirmed(session, env);
    // Cache only after durable confirm — never as sole source of truth.
    memoryMap().set(session.id, session);
    return session;
  }

  if (!allowMemorySessionFallback(env)) {
    throw new Error(
      "Session store unavailable: configure Supabase for Preview/Production sessions"
    );
  }

  memoryMap().set(session.id, session);
  return session;
}

export async function getStoredSession(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<StoredSession | null> {
  if (!id) return null;
  let session: StoredSession | null = null;

  if (isSupabaseConfigured(env)) {
    session = await supabaseGet(id, env);
    if (session) memoryMap().set(session.id, session);
  } else if (allowMemorySessionFallback(env)) {
    session = memoryMap().get(id) || null;
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

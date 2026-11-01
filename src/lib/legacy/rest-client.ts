/**
 * Read-only PostgREST client for the legacy snapshot tables (AUTH_PROVIDER=legacy only; removed at T6).
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY server-side only. Never log the service role key.
 */

import { supabaseRestAuthHeaders } from "./rest-auth";

export type DbFilter = Record<string, string | number | boolean | null>;

export type SelectOpts = {
  columns?: string;
  eq?: DbFilter;
  order?: { column: string; ascending?: boolean };
  limit?: number;
};

/** The legacy snapshot is never written by this app: only reads exist. */
export interface LegacyDb {
  select(table: string, opts?: SelectOpts): Promise<Record<string, unknown>[]>;
  count(table: string, eq?: DbFilter): Promise<number>;
}

function encodeFilters(eq?: DbFilter): string {
  if (!eq) return "";
  return Object.entries(eq)
    .map(([k, v]) => {
      if (v === null) return `${encodeURIComponent(k)}=is.null`;
      return `${encodeURIComponent(k)}=eq.${encodeURIComponent(String(v))}`;
    })
    .join("&");
}

export function isValidSupabaseUrl(url: string): boolean {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isSupabaseConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const url = (env.SUPABASE_URL || "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return Boolean(url && key && isValidSupabaseUrl(url));
}

export function createLegacyRestClient(
  env: NodeJS.ProcessEnv = process.env
): LegacyDb {
  if (!isSupabaseConfigured(env)) {
    throw new Error("Supabase credentials not configured");
  }
  const base = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  async function request(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
    const h = new Headers({ ...supabaseRestAuthHeaders(key), "Content-Type": "application/json" });
    if (init.prefer) h.set("Prefer", init.prefer);
    const res = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: h });
    if (!res.ok) {
      // Never include Authorization or key material in thrown errors.
      const body = await res.text().catch(() => "");
      const safe = body.replace(key, "[redacted]").slice(0, 240);
      throw new Error(`Legacy DB HTTP ${res.status}: ${safe || res.statusText}`);
    }
    return res;
  }

  return {
    async select(table, opts = {}) {
      const parts = [`select=${encodeURIComponent(opts.columns || "*")}`];
      const filters = encodeFilters(opts.eq);
      if (filters) parts.push(filters);
      if (opts.order) {
        parts.push(
          `order=${encodeURIComponent(opts.order.column)}.${opts.order.ascending === false ? "desc" : "asc"}`
        );
      }
      if (opts.limit != null) parts.push(`limit=${opts.limit}`);
      const res = await request(`${table}?${parts.join("&")}`, { method: "GET" });
      const data = (await res.json()) as Record<string, unknown>[];
      return Array.isArray(data) ? data : [];
    },

    async count(table, eq) {
      const parts = ["select=id"];
      const filters = encodeFilters(eq);
      if (filters) parts.push(filters);
      const res = await fetch(`${base}/rest/v1/${table}?${parts.join("&")}`, {
        method: "HEAD",
        headers: { ...supabaseRestAuthHeaders(key), Prefer: "count=exact" },
      });
      if (res.ok) {
        const range = res.headers.get("content-range");
        const total = range?.includes("/") ? range.split("/")[1] : "*";
        const n = Number(total);
        if (total !== "*" && !Number.isNaN(n)) return n;
      }
      const rows = await this.select(table, { columns: "id", eq, limit: 10000 });
      return rows.length;
    },
  };
}

/** In-process read-only DB over fixed rows, for tests (no real Supabase). */
export function createMockLegacyDb(tables: Record<string, Record<string, unknown>[]> = {}): LegacyDb & {
  tables: Record<string, Record<string, unknown>[]>;
} {
  const matches = (row: Record<string, unknown>, eq?: DbFilter) =>
    !eq || Object.entries(eq).every(([k, v]) => row[k] === v);
  return {
    tables,
    async select(table, opts = {}) {
      let rows = (tables[table] ?? []).filter((r) => matches(r, opts.eq));
      if (opts.order) {
        const col = opts.order.column;
        const asc = opts.order.ascending !== false;
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (opts.limit != null) rows = rows.slice(0, opts.limit);
      return rows.map((r) => ({ ...r }));
    },
    async count(table, eq) {
      return (tables[table] ?? []).filter((r) => matches(r, eq)).length;
    },
  };
}

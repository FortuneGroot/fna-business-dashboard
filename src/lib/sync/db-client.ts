/**
 * Minimal PostgREST client for Supabase Postgres.
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY server-side only.
 * Never log the service role key.
 */

export type DbFilter = Record<string, string | number | boolean | null>;

export type SelectOpts = {
  columns?: string;
  eq?: DbFilter;
  order?: { column: string; ascending?: boolean };
  limit?: number;
};

export interface SyncDb {
  upsert(
    table: string,
    row: Record<string, unknown>,
    onConflict: string
  ): Promise<Record<string, unknown>>;
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, unknown>>;
  insertMany(table: string, rows: Record<string, unknown>[]): Promise<void>;
  select(table: string, opts?: SelectOpts): Promise<Record<string, unknown>[]>;
  delete(table: string, eq: DbFilter): Promise<void>;
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

export function isSupabaseConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const url = (env.SUPABASE_URL || "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return Boolean(url && key && url.startsWith("http"));
}

export function createSupabaseRestClient(
  env: NodeJS.ProcessEnv = process.env
): SyncDb {
  const base = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!base || !key) {
    throw new Error("Supabase credentials not configured");
  }

  const headers = (): HeadersInit => ({
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  });

  async function request(
    path: string,
    init: RequestInit & { prefer?: string } = {}
  ): Promise<Response> {
    const h = new Headers(headers());
    if (init.prefer) h.set("Prefer", init.prefer);
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: h,
    });
    if (!res.ok) {
      // Never include Authorization or key material in thrown errors.
      const body = await res.text().catch(() => "");
      const safe = body.replace(key, "[redacted]").slice(0, 240);
      throw new Error(`Sync DB HTTP ${res.status}: ${safe || res.statusText}`);
    }
    return res;
  }

  return {
    async upsert(table, row, onConflict) {
      const qs = `on_conflict=${encodeURIComponent(onConflict)}`;
      const res = await request(`${table}?${qs}`, {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "resolution=merge-duplicates,return=representation",
      });
      const data = (await res.json()) as Record<string, unknown>[] | Record<string, unknown>;
      const rowOut = Array.isArray(data) ? data[0] : data;
      return rowOut || row;
    },

    async insert(table, row) {
      const res = await request(table, {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "return=representation",
      });
      const data = (await res.json()) as Record<string, unknown>[] | Record<string, unknown>;
      return (Array.isArray(data) ? data[0] : data) || row;
    },

    async insertMany(table, rows) {
      if (!rows.length) return;
      await request(table, {
        method: "POST",
        body: JSON.stringify(rows),
        prefer: "return=minimal",
      });
    },

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

    async delete(table, eq) {
      const filters = encodeFilters(eq);
      await request(`${table}?${filters}`, {
        method: "DELETE",
        prefer: "return=minimal",
      });
    },

    async count(table, eq) {
      const parts = ["select=id"];
      const filters = encodeFilters(eq);
      if (filters) parts.push(filters);
      // Prefer count via Content-Range when available
      const base = (env.SUPABASE_URL || "").trim().replace(/\/$/, "");
      const key = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
      const res = await fetch(`${base}/rest/v1/${table}?${parts.join("&")}`, {
        method: "HEAD",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "count=exact",
        },
      });
      if (!res.ok) {
        // Fallback: select and length (bounded)
        const rows = await this.select(table, { columns: "id", eq, limit: 10000 });
        return rows.length;
      }
      const range = res.headers.get("content-range");
      if (range && range.includes("/")) {
        const total = range.split("/")[1];
        const n = Number(total);
        if (!Number.isNaN(n) && total !== "*") return n;
      }
      const rows = await this.select(table, { columns: "id", eq, limit: 10000 });
      return rows.length;
    },
  };
}

/** In-process mock DB for contract tests (no real Supabase). */
export function createMockSyncDb(): SyncDb & {
  tables: Record<string, Record<string, unknown>[]>;
} {
  const tables: Record<string, Record<string, unknown>[]> = {};

  const ensure = (table: string) => {
    if (!tables[table]) tables[table] = [];
    return tables[table];
  };

  const matches = (row: Record<string, unknown>, eq?: DbFilter) => {
    if (!eq) return true;
    return Object.entries(eq).every(([k, v]) => row[k] === v);
  };

  return {
    tables,
    async upsert(table, row, onConflict) {
      const cols = onConflict.split(",").map((c) => c.trim());
      const list = ensure(table);
      const idx = list.findIndex((r) => cols.every((c) => r[c] === row[c]));
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...row };
        return list[idx];
      }
      const next = { id: row.id || `mock_${table}_${list.length + 1}`, ...row };
      list.push(next);
      return next;
    },
    async insert(table, row) {
      const list = ensure(table);
      const next = { id: row.id || `mock_${table}_${list.length + 1}`, ...row };
      list.push(next);
      return next;
    },
    async insertMany(table, rows) {
      for (const row of rows) await this.insert(table, row);
    },
    async select(table, opts = {}) {
      let rows = ensure(table).filter((r) => matches(r, opts.eq));
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
    async delete(table, eq) {
      const list = ensure(table);
      tables[table] = list.filter((r) => !matches(r, eq));
    },
    async count(table, eq) {
      return ensure(table).filter((r) => matches(r, eq)).length;
    },
  };
}

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const ROOT = join(__dirname, "..", "..");
export const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
export const ROLLBACK_FILE = join(ROOT, "supabase", "rollback", "20261101_native_multi_tenant.down.sql");
const SHIM = join(__dirname, "supabase-local-shim.sql");

/** Upper bound for one simulated request. PGlite has a single connection, so a stuck session hangs every later query. */
export const SESSION_TIMEOUT_MS = 20_000;

export type Db = PGlite;
export type Q = Transaction;

export type TestUser = { id: string; email: string; aal?: "aal1" | "aal2" };

export class NestedSessionError extends Error {
  constructor(what: string) {
    super(
      `${what} called while a simulated request is open on the same PGlite instance. ` +
        "PGlite has one connection, so this would deadlock. Finish the outer request first."
    );
    this.name = "NestedSessionError";
  }
}

const openSessions = new WeakSet<PGlite>();

/** Makes db.query / db.exec / db.transaction fail fast instead of deadlocking inside asUser/asAnon. */
function guard(db: PGlite): PGlite {
  for (const method of ["query", "exec", "transaction"] as const) {
    const original = (db[method] as (...args: unknown[]) => Promise<unknown>).bind(db);
    (db as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      if (openSessions.has(db)) return Promise.reject(new NestedSessionError(`db.${method}`));
      return original(...args);
    };
  }
  return db;
}

async function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Applies SQL as the migration owner (non-superuser with BYPASSRLS, like Supabase's `postgres`). */
export async function execAsOwner(db: Db, sql: string): Promise<void> {
  await db.exec("set role migration_owner");
  try {
    await db.exec(sql);
  } finally {
    await db.exec("reset role");
  }
}

export type FreshDbOptions = {
  /** Runs (as superuser) immediately before the named migration file is applied. */
  beforeMigration?: Record<string, (db: Db) => Promise<void>>;
};

/** In-process local Postgres with the Supabase shim and every repository migration applied in order. */
export async function freshDb(options: FreshDbOptions = {}): Promise<Db> {
  if (process.env.VERCEL_ENV) {
    throw new Error("Database tests refuse to run when VERCEL_ENV is set.");
  }
  const db = await PGlite.create({ extensions: { btree_gist, citext, pgcrypto } });
  await db.exec(readFileSync(SHIM, "utf8"));
  await db.exec(`set search_path = "$user", public, extensions`);
  for (const file of migrationFiles()) {
    await options.beforeMigration?.[file]?.(db);
    try {
      await execAsOwner(db, readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return guard(db);
}

/** Simulates a Supabase Auth sign-up (auth.users row). Test setup only. */
export async function createUser(db: Db, email: string, aal: "aal1" | "aal2" = "aal1"): Promise<TestUser> {
  const res = await db.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify({ full_name: email.split("@")[0] })]
  );
  return { id: res.rows[0].id, email, aal };
}

/** Test setup only: marks a user as platform admin (stands in for scripts/bootstrap-platform-admin.ts). */
export async function makePlatformAdmin(db: Db, user: TestUser): Promise<void> {
  await db.query("insert into public.platform_admins (user_id) values ($1)", [user.id]);
}

async function session<T>(
  db: Db,
  label: string,
  setup: (tx: Q) => Promise<void>,
  fn: (q: Q) => Promise<T>
): Promise<T> {
  if (openSessions.has(db)) throw new NestedSessionError(label);
  return withTimeout(
    label,
    SESSION_TIMEOUT_MS,
    db.transaction(async (tx) => {
      openSessions.add(db);
      try {
        await setup(tx);
        return await fn(tx);
      } finally {
        openSessions.delete(db);
      }
    })
  );
}

/**
 * Runs `fn` exactly as PostgREST would for a signed-in user: role `authenticated` with the
 * user's JWT claims. RLS and grants apply. Rolled back if `fn` throws.
 * Must not be nested (throws NestedSessionError) and is bounded by SESSION_TIMEOUT_MS.
 */
export async function asUser<T>(db: Db, user: TestUser, fn: (q: Q) => Promise<T>): Promise<T> {
  return session(db, "asUser", async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user.id, email: user.email, role: "authenticated", aal: user.aal ?? "aal1" }),
    ]);
  }, fn);
}

/** Runs `fn` as an unauthenticated PostgREST request (role `anon`, no JWT subject). */
export async function asAnon<T>(db: Db, fn: (q: Q) => Promise<T>): Promise<T> {
  return session(db, "asAnon", async (tx) => {
    await tx.exec("set local role anon");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
  }, fn);
}

/** Runs `fn` as the server-side service role (role `service_role`, no JWT subject). */
export async function asServiceRole<T>(db: Db, fn: (q: Q) => Promise<T>): Promise<T> {
  return session(db, "asServiceRole", async (tx) => {
    await tx.exec("set local role service_role");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  }, fn);
}

export async function rpc<T = unknown>(q: Q, fn: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  const res = await q.query<{ r: T }>(`select public.${fn}(${placeholders}) as r`, args);
  return res.rows[0]?.r as T;
}

export async function rows<T = Record<string, unknown>>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}

/** Superuser count used only for verification of setup/outcomes, never to demonstrate RLS. */
export async function adminCount(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const res = await db.query<{ n: number | string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

export type World = {
  db: Db;
  platform: TestUser;
  ownerA: TestUser;
  adminA: TestUser;
  employeeA: TestUser;
  ownerB: TestUser;
  employeeB: TestUser;
  dual: TestUser;
  outsider: TestUser;
  wsA: string;
  wsB: string;
};

export async function invite(db: Db, inviter: TestUser, email: string, role: string): Promise<string> {
  const res = await asUser(db, inviter, (q) =>
    rpc<{ token: string }>(q, "create_invitation", [email, role, 72])
  );
  return res.token;
}

export async function accept(db: Db, user: TestUser, token: string): Promise<void> {
  await asUser(db, user, (q) => rpc(q, "accept_invitation", [token]));
}

/**
 * Two provisioned workspaces populated only through user-scoped RPCs and invitations.
 * Both are synthetic fixtures (example.test addresses only); they are not real clients.
 */
export async function buildWorld(): Promise<World> {
  const db = await freshDb();
  const platform = await createUser(db, "platform@example.test", "aal2");
  await makePlatformAdmin(db, platform);

  const ownerA = await createUser(db, "owner-a@example.test");
  const adminA = await createUser(db, "admin-a@example.test");
  const employeeA = await createUser(db, "employee-a@example.test");
  const ownerB = await createUser(db, "owner-b@example.test");
  const employeeB = await createUser(db, "employee-b@example.test");
  const dual = await createUser(db, "dual@example.test");
  const outsider = await createUser(db, "outsider@example.test");

  const provA = await asUser(db, platform, (q) =>
    rpc<{ workspace_id: string; invite_token: string }>(q, "platform_provision_workspace", [
      "synthetic-tj-towing", "TJ Towing (synthetic)", "tj-towing-synthetic", ownerA.email,
    ])
  );
  const provB = await asUser(db, platform, (q) =>
    rpc<{ workspace_id: string; invite_token: string }>(q, "platform_provision_workspace", [
      "synthetic-vinny-moving", "Vinny Moving (synthetic)", "vinny-moving-synthetic", ownerB.email,
    ])
  );
  await accept(db, ownerA, provA.invite_token);
  await accept(db, ownerB, provB.invite_token);

  await accept(db, adminA, await invite(db, ownerA, adminA.email, "admin"));
  await accept(db, employeeA, await invite(db, ownerA, employeeA.email, "employee"));
  await accept(db, employeeB, await invite(db, ownerB, employeeB.email, "employee"));
  await accept(db, dual, await invite(db, ownerB, dual.email, "employee"));
  await accept(db, dual, await invite(db, ownerA, dual.email, "employee"));

  return {
    db, platform, ownerA, adminA, employeeA, ownerB, employeeB, dual, outsider,
    wsA: provA.workspace_id, wsB: provB.workspace_id,
  };
}

/** Creates a contact as `user` in their active workspace through RLS (created_by is stamped by the database). */
export async function createContact(db: Db, user: TestUser, ws: string, name: string): Promise<string> {
  return asUser(db, user, async (q) => {
    const r = await rows<{ id: string }>(
      q,
      "insert into public.contacts (workspace_id, first_name) values ($1, $2) returning id",
      [ws, name]
    );
    return r[0].id;
  });
}

export async function stageId(db: Db, user: TestUser, position: number): Promise<{ id: string; pipeline_id: string }> {
  return asUser(db, user, async (q) => {
    const r = await rows<{ id: string; pipeline_id: string }>(
      q,
      "select id, pipeline_id from public.pipeline_stages where position = $1",
      [position]
    );
    if (r.length !== 1) throw new Error(`expected one stage at position ${position}, got ${r.length}`);
    return r[0];
  });
}

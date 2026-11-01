// Real local PostgreSQL (embedded-postgres binaries, no Docker) for checks that need independent
// sessions, which single-connection PGlite cannot provide. This is plain PostgreSQL with the test
// shim, NOT a Supabase stack: no PostgREST, GoTrue/JWT verification, or Storage.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { MIGRATIONS_DIR, migrationFiles } from "../db/harness";

const SHIM = join(__dirname, "..", "db", "supabase-local-shim.sql");
const PASSWORD = "local-test-only";
const DATABASE = "fna_test";

/** Marker the test runner uses to report an environment problem as BLOCKED rather than PASS/FAIL. */
export const BLOCKED_MARKER = "BLOCKED:";

export class BlockedError extends Error {
  constructor(reason: string) {
    super(`${BLOCKED_MARKER} ${reason}`);
    this.name = "BlockedError";
  }
}

const VC_DLLS = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

/** The Windows PostgreSQL binaries need the system-wide Microsoft Visual C++ 2015-2022 x64 runtime. */
function ensureVcRuntime(): string {
  if (process.platform !== "win32") return "not required";
  const system32 = join(process.env.WINDIR ?? "C:\\Windows", "System32");
  if (VC_DLLS.every((d) => existsSync(join(system32, d)))) return "system";
  throw new BlockedError("Microsoft Visual C++ 2015-2022 x64 runtime is not installed.");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export type RealPg = {
  runtime: string;
  version: string;
  connect: () => Promise<pg.Client>;
  stop: () => Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
};

export async function startRealPostgres(): Promise<RealPg> {
  if (process.env.VERCEL_ENV) throw new Error("Real-Postgres tests refuse to run when VERCEL_ENV is set.");
  const runtime = ensureVcRuntime();

  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const entry = require.resolve("embedded-postgres");
    EmbeddedPostgres = (await import(pathToFileURL(entry).href)).default as EmbeddedPostgresCtor;
  } catch (err) {
    throw new BlockedError(`embedded-postgres is not installed (${(err as Error).message}).`);
  }

  const dir = mkdtempSync(join(tmpdir(), "fna-realpg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir, user: "postgres", password: PASSWORD, port, persistent: false,
    onLog: () => {}, onError: () => {},
  });
  try {
    await server.initialise();
    await server.start();
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new BlockedError(`local PostgreSQL failed to start (${(err as Error).message.slice(0, 200)}).`);
  }
  await server.createDatabase(DATABASE);

  const connect = async () => {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: PASSWORD, database: DATABASE });
    await client.connect();
    return client;
  };

  const admin = await connect();
  try {
    await admin.query(`alter database ${DATABASE} set search_path = "$user", public, extensions`);
    await admin.query(readFileSync(SHIM, "utf8"));
    for (const file of migrationFiles()) {
      await admin.query("set role migration_owner");
      try {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      } catch (err) {
        throw new Error(`Migration ${file} failed on real PostgreSQL: ${(err as Error).message}`);
      } finally {
        await admin.query("reset role");
      }
    }
  } finally {
    await admin.end();
  }

  const probe = await connect();
  const version = (await probe.query<{ v: string }>("select current_setting('server_version') v")).rows[0].v;
  await probe.end();

  return {
    runtime,
    version,
    connect,
    stop: async () => {
      await server.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type RealUser = { id: string; email: string; aal?: "aal1" | "aal2" };

/** Opens a PostgREST-equivalent request on `client`: transaction, role authenticated, JWT claims. */
export async function beginAs(client: pg.Client, user: RealUser): Promise<void> {
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: user.id, email: user.email, role: "authenticated", aal: user.aal ?? "aal1" }),
  ]);
}

/** One complete request as `user`; commits on success, rolls back on error. */
export async function requestAs<T = unknown>(client: pg.Client, user: RealUser, sql: string, params: unknown[] = []): Promise<T[]> {
  await beginAs(client, user);
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res.rows as T[];
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

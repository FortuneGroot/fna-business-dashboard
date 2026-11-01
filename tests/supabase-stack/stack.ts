// Real local Supabase stack (Docker + Supabase CLI) for checks that need GoTrue, PostgREST, real
// JWT verification, and Storage. Migrations are applied by the Supabase CLI.
//
// The suite never touches the developer's own local stack. It builds an isolated, explicitly
// disposable copy of the project in a temp directory (random `fna-disposable-*` project id, its
// own Docker volumes, ports shifted by PORT_OFFSET, marker file), starts it, and only resets or
// destroys a stack that passes assertDisposable. Keys are never printed.
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import pg from "pg";
import { BlockedError } from "../db-real/realpg";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "node_modules", "supabase", "dist", "supabase.js");
const DOCKER_DIRS = process.platform === "win32" ? ["C:\\Program Files\\Docker\\Docker\\resources\\bin"] : [];

export const DISPOSABLE_PREFIX = "fna-disposable-";
export const DISPOSABLE_MARKER = ".fna-disposable-stack.json";
export const PORT_OFFSET = 1000;

export type StackEnv = {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
};

export type DisposableProject = {
  workdir: string;
  projectId: string;
  token: string;
  apiPort: number;
  dbPort: number;
};

function run(cmd: string, args: string[], timeoutMs: number) {
  const env = { ...process.env, PATH: [...DOCKER_DIRS, process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":") };
  return spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
}

function supabase(project: DisposableProject, args: string[], timeoutMs = 120_000) {
  return run(process.execPath, [CLI, ...args, "--workdir", project.workdir], timeoutMs);
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

function portOf(url: string): number {
  return Number(new URL(url.replace(/^postgres(ql)?:/, "http:")).port);
}

/**
 * Copies config.toml and migrations into a fresh temp directory with a random disposable project
 * id and shifted ports. Nothing else (no `.temp`, no linked project ref, no env files) is copied.
 */
export function createDisposableProject(sourceDir = join(ROOT, "supabase")): DisposableProject {
  const workdir = mkdtempSync(join(tmpdir(), "fna-disposable-stack-"));
  const token = randomBytes(6).toString("hex");
  const projectId = `${DISPOSABLE_PREFIX}${token}`;
  const dest = join(workdir, "supabase");
  mkdirSync(join(dest, "migrations"), { recursive: true });
  for (const f of readdirSync(join(sourceDir, "migrations")).filter((x) => x.endsWith(".sql"))) {
    copyFileSync(join(sourceDir, "migrations", f), join(dest, "migrations", f));
  }
  let apiPort = 0;
  let dbPort = 0;
  let section = "";
  const config = readFileSync(join(sourceDir, "config.toml"), "utf8")
    .split(/\r?\n/)
    .map((line) => {
      const header = /^\s*\[([^\]]+)\]/.exec(line);
      if (header) section = header[1];
      if (/^project_id\s*=/.test(line)) return `project_id = "${projectId}"`;
      const port = /^(\s*(?:port|shadow_port|inspector_port)\s*=\s*)(\d+)(.*)$/.exec(line);
      if (!port) return line;
      const shifted = Number(port[2]) + PORT_OFFSET;
      if (section === "api" && /^\s*port/.test(port[1])) apiPort = shifted;
      if (section === "db" && /^\s*port/.test(port[1])) dbPort = shifted;
      return `${port[1]}${shifted}${port[3]}`;
    })
    .join("\n");
  if (!apiPort || !dbPort) throw new Error("config.toml has no [api] or [db] port");
  writeFileSync(join(dest, "config.toml"), config);
  writeFileSync(join(workdir, DISPOSABLE_MARKER), JSON.stringify({ projectId, token, disposable: true }));
  return { workdir, projectId, token, apiPort, dbPort };
}

/**
 * Throws unless `env` is the stack this run created for `project`: started by this run, inside the
 * OS temp directory, carrying the matching marker and project id, and serving on the shifted local
 * ports. Called before every reset and before destroying volumes.
 */
export function assertDisposable(project: DisposableProject, env: StackEnv | null, startedHere: boolean): void {
  const problems = disposableProjectProblems(project);
  if (!startedHere) problems.push("the stack was not started by this run");
  if (!env) {
    problems.push("stack status is unavailable");
  } else {
    if (!isLocal(env.apiUrl) || portOf(env.apiUrl) !== project.apiPort) problems.push("API is not on the disposable local port");
    if (!isLocal(env.dbUrl.replace(/^postgres(ql)?:/, "http:")) || portOf(env.dbUrl) !== project.dbPort) {
      problems.push("database is not on the disposable local port");
    }
  }
  if (problems.length) throw new Error(`Refusing to reset or destroy the Supabase stack: ${problems.join("; ")}.`);
}

/** Project-level guards: temp location, marker, disposable project id, no remote link. */
export function disposableProjectProblems(project: DisposableProject): string[] {
  const problems: string[] = [];
  const tmp = realpathSync(tmpdir());
  const rel = existsSync(project.workdir) ? relative(tmp, realpathSync(project.workdir)) : "..";
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) problems.push("workdir is not inside the OS temp directory");
  if (!project.projectId.startsWith(DISPOSABLE_PREFIX)) problems.push("project id is not disposable");
  try {
    const marker = JSON.parse(readFileSync(join(project.workdir, DISPOSABLE_MARKER), "utf8"));
    if (marker.disposable !== true || marker.token !== project.token || marker.projectId !== project.projectId) {
      problems.push("disposable marker does not match");
    }
  } catch {
    problems.push("disposable marker is missing");
  }
  try {
    const cfg = readFileSync(join(project.workdir, "supabase", "config.toml"), "utf8");
    if (/^project_id\s*=\s*"([^"]*)"/m.exec(cfg)?.[1] !== project.projectId) problems.push("config project_id does not match");
  } catch {
    problems.push("config.toml is missing");
  }
  if (existsSync(join(project.workdir, "supabase", ".temp", "project-ref"))) problems.push("workdir is linked to a remote project");
  return problems;
}

function readStatus(project: DisposableProject): StackEnv | null {
  const res = supabase(project, ["status", "-o", "json"], 60_000);
  if (res.status !== 0) return null;
  const start = res.stdout.indexOf("{");
  if (start < 0) return null;
  const s = JSON.parse(res.stdout.slice(start)) as Record<string, string>;
  const env: StackEnv = {
    apiUrl: s.API_URL,
    dbUrl: s.DB_URL,
    anonKey: s.ANON_KEY,
    serviceRoleKey: s.SERVICE_ROLE_KEY,
    jwtSecret: s.JWT_SECRET,
  };
  for (const [k, v] of Object.entries(env)) {
    if (!v) throw new Error(`supabase status did not report ${k}`);
  }
  return env;
}

const tail = (r: { stdout: string; stderr: string }, n: number) =>
  (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-n).join(" | ");

export type Stack = { env: StackEnv; project: DisposableProject; stop: () => void };

/** Creates, starts, verifies, and resets a disposable stack so every migration is applied by the CLI. */
export function startStack(): Stack {
  if (process.env.VERCEL_ENV) throw new Error("Stack tests refuse to run when VERCEL_ENV is set.");
  if (!existsSync(CLI)) throw new BlockedError("Supabase CLI is not installed (npm devDependency `supabase`).");
  const docker = run("docker", ["info", "--format", "{{.ServerVersion}}"], 30_000);
  if (docker.error || docker.status !== 0) {
    throw new BlockedError("Docker engine is not running (Docker Desktop requires WSL2 and firmware virtualization).");
  }

  const project = createDisposableProject();
  let startedHere = false;
  // Stopping needs only the project-level guards: the random project id exists solely for this run.
  const stop = () => {
    const problems = disposableProjectProblems(project);
    if (startedHere && problems.length === 0) {
      supabase(project, ["stop", "--no-backup"], 300_000);
      rmSync(project.workdir, { recursive: true, force: true });
    } else if (problems.length) {
      console.error(`Not destroying Supabase stack volumes: ${problems.join("; ")}.`);
    } else {
      rmSync(project.workdir, { recursive: true, force: true });
    }
  };

  try {
    const started = supabase(project, ["start"], 900_000);
    startedHere = true;
    if (started.status !== 0) throw new Error(`supabase start failed: ${tail(started, 5)}`);
    assertDisposable(project, readStatus(project), startedHere);
    const reset = supabase(project, ["db", "reset", "--local", "--no-seed"], 600_000);
    if (reset.status !== 0) throw new Error(`supabase db reset failed: ${tail(reset, 8)}`);
    const env = readStatus(project);
    assertDisposable(project, env, startedHere);
    return { env: env!, project, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

/** Superuser connection for test setup and outcome verification only — never to demonstrate RLS. */
export async function adminDb(env: StackEnv): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: env.dbUrl });
  await client.connect();
  return client;
}

export type HttpResult = { status: number; body: any; text: string };

async function http(url: string, init: RequestInit): Promise<HttpResult> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

export type Identity = { id: string; email: string; password: string; token: string };

export function newPassword(): string {
  return `Local-${randomBytes(18).toString("hex")}`;
}

/** Real GoTrue sign-up (email confirmations are disabled in the local config). */
export async function signUp(env: StackEnv, email: string, fullName: string): Promise<Identity> {
  const password = newPassword();
  const r = await http(`${env.apiUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, data: { full_name: fullName } }),
  });
  if (r.status !== 200 || !r.body?.access_token) throw new Error(`sign-up failed for ${email}: ${r.status} ${r.text.slice(0, 200)}`);
  return { id: r.body.user.id, email, password, token: r.body.access_token };
}

export function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of input.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error("invalid base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as used by GoTrue. */
export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/** Enrolls a TOTP factor and verifies it, returning an AAL2 access token. */
export async function upgradeToAal2(env: StackEnv, user: Identity): Promise<string> {
  const auth = { apikey: env.anonKey, Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
  const enroll = await http(`${env.apiUrl}/auth/v1/factors`, {
    method: "POST", headers: auth, body: JSON.stringify({ factor_type: "totp", friendly_name: "stack-test" }),
  });
  if (enroll.status !== 200) throw new Error(`MFA enroll failed: ${enroll.status} ${enroll.text.slice(0, 200)}`);
  const factorId: string = enroll.body.id;
  const secret: string = enroll.body.totp.secret;
  const challenge = await http(`${env.apiUrl}/auth/v1/factors/${factorId}/challenge`, { method: "POST", headers: auth, body: "{}" });
  if (challenge.status !== 200) throw new Error(`MFA challenge failed: ${challenge.status} ${challenge.text.slice(0, 200)}`);
  const verify = await http(`${env.apiUrl}/auth/v1/factors/${factorId}/verify`, {
    method: "POST", headers: auth, body: JSON.stringify({ challenge_id: challenge.body.id, code: totp(secret) }),
  });
  if (verify.status !== 200 || !verify.body?.access_token) throw new Error(`MFA verify failed: ${verify.status} ${verify.text.slice(0, 200)}`);
  return verify.body.access_token;
}

/** PostgREST request with a user's own JWT (or no JWT for anon). */
export async function rest(
  env: StackEnv,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return http(`${env.apiUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.anonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function rpc(env: StackEnv, token: string | null, fn: string, args: Record<string, unknown> = {}): Promise<HttpResult> {
  return rest(env, token, "POST", `rpc/${fn}`, args);
}

/** Service-role request — used only to show the legacy app's server-side access is retained. */
export async function serviceRest(env: StackEnv, path: string): Promise<HttpResult> {
  return http(`${env.apiUrl}/rest/v1/${path}`, {
    headers: { apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}` },
  });
}

export async function storage(
  env: StackEnv,
  token: string | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  objectPath: string,
  content?: string,
  options: { upsert?: boolean } = {}
): Promise<HttpResult> {
  return http(`${env.apiUrl}/storage/v1/object/${objectPath}`, {
    method,
    headers: {
      apikey: env.anonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(content !== undefined ? { "Content-Type": "text/plain" } : {}),
      ...(options.upsert ? { "x-upsert": "true" } : {}),
    },
    body: content,
  });
}

/** HS256 JWT signed with the local stack's JWT secret (for expired/forged token checks). */
export function signJwt(secret: string, payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

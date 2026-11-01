/**
 * Platform-admin bootstrap and operator tool (spec §6.4 A2, §20.4 item 4). CLI only.
 *
 *   tsx scripts/bootstrap-platform-admin.ts grant      --email <e> --env <local|staging|production> [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts revoke     --email <e> --env <...> --reason "<why>" [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts remove-mfa --email <e> --env <...> --reason "<why>" [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts list       --env <...>
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment (never from arguments or
 * files, never printed). `--env local` only accepts a loopback URL. `--env staging|production`
 * only accepts an https, non-loopback URL, needs an interactive terminal, and the operator must
 * type the confirmation phrase shown. Every change is written to platform_audit_log.
 * MFA recovery: `remove-mfa` deletes the user's factors, so the admin's next sign-in is AAL1 and
 * must enrol a new authenticator before the console opens; there are no recovery codes. It does
 * not end sessions; if the device may be compromised, also revoke the admin (or reset the password).
 */

export type TargetEnv = "local" | "staging" | "production";
export type Command = "grant" | "revoke" | "remove-mfa" | "list";
export type Args = { command: Command; email: string | null; env: TargetEnv; reason: string | null; dryRun: boolean };
export type Target = { url: string; host: string; local: boolean };

export class UsageError extends Error {}

const COMMANDS: readonly Command[] = ["grant", "revoke", "remove-mfa", "list"];
const ENVS: readonly TargetEnv[] = ["local", "staging", "production"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) throw new UsageError(`command must be one of: ${COMMANDS.join(", ")}`);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (!["email", "env", "reason", "dry-run"].includes(name)) throw new UsageError(`unknown option: ${a}`);
    if (flags.has(name)) throw new UsageError(`repeated option: ${a}`);
    if (name === "dry-run") {
      flags.set(name, true);
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${a} needs a value`);
    flags.set(name, value);
  }
  const env = flags.get("env");
  if (typeof env !== "string" || !ENVS.includes(env as TargetEnv)) throw new UsageError(`--env must be one of: ${ENVS.join(", ")}`);
  const email = typeof flags.get("email") === "string" ? (flags.get("email") as string).trim().toLowerCase() : null;
  if (command !== "list" && (!email || !EMAIL.test(email))) throw new UsageError("--email must be a valid address");
  if (command === "list" && email) throw new UsageError("list takes no --email");
  const reason = typeof flags.get("reason") === "string" ? (flags.get("reason") as string).trim() : null;
  if ((command === "revoke" || command === "remove-mfa") && (!reason || reason.length < 5 || reason.length > 500)) {
    throw new UsageError("--reason (5–500 characters) is required; it is written to the audit log");
  }
  return { command: command as Command, email, env: env as TargetEnv, reason, dryRun: flags.get("dry-run") === true };
}

/** Validates SUPABASE_URL against --env. Throws UsageError; never echoes credentials. */
export function checkTarget(env: TargetEnv, rawUrl: string | undefined): Target {
  if (!rawUrl?.trim()) throw new UsageError("SUPABASE_URL is not set");
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new UsageError("SUPABASE_URL is not a valid URL");
  }
  if (u.username || u.password) throw new UsageError("SUPABASE_URL must not contain credentials");
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError("SUPABASE_URL must be http(s)");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new UsageError("SUPABASE_URL must be the project origin only");
  const local = LOOPBACK.has(u.hostname);
  if (env === "local" && !local) throw new UsageError(`--env local refuses a non-local target (${u.hostname})`);
  if (env !== "local" && local) throw new UsageError(`--env ${env} refuses a loopback target; use --env local`);
  if (env !== "local" && u.protocol !== "https:") throw new UsageError(`--env ${env} requires https`);
  return { url: u.origin, host: u.hostname, local };
}

export function checkServiceKey(key: string | undefined): string {
  const k = key?.trim();
  if (!k) throw new UsageError("SUPABASE_SERVICE_ROLE_KEY is not set");
  if (k.startsWith("sb_secret_")) return k;
  try {
    const payload = JSON.parse(Buffer.from(k.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (payload?.role === "service_role") return k;
  } catch {
    // fall through
  }
  throw new UsageError("SUPABASE_SERVICE_ROLE_KEY is not a service-role key");
}

export const confirmationPhrase = (args: Args, target: Target) =>
  `${args.command} ${args.email ?? "all"} on ${args.env} ${target.host}`;

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (line: string) => void;
  /** Interactive prompt; null when stdin is not a terminal. */
  prompt: ((question: string) => Promise<string>) | null;
};

type Json = Record<string, any>;

class Api {
  constructor(private readonly target: Target, private readonly key: string, private readonly f: typeof fetch) {}

  async call(method: string, path: string, body?: unknown, prefer?: string): Promise<any> {
    const res = await this.f(`${this.target.url}${path}`, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  async userByEmail(email: string): Promise<Json | null> {
    for (let page = 1; page <= 1000; page++) {
      const r = await this.call("GET", `/auth/v1/admin/users?page=${page}&per_page=200`);
      const users: Json[] = r?.users ?? [];
      const hit = users.find((u) => String(u.email ?? "").toLowerCase() === email);
      if (hit) return hit;
      if (users.length < 200) return null;
    }
    throw new Error("user listing did not end");
  }

  admins(): Promise<{ user_id: string; created_at: string }[]> {
    return this.call("GET", "/rest/v1/platform_admins?select=user_id,created_at&order=created_at");
  }

  audit(action: string, reason: string | null, metadata: Json): Promise<unknown> {
    return this.call("POST", "/rest/v1/platform_audit_log", { actor_id: null, action, reason, metadata }, "return=minimal");
  }
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  let args: Args;
  let target: Target;
  let key: string;
  try {
    args = parseArgs(argv);
    target = checkTarget(args.env, deps.env.SUPABASE_URL);
    key = checkServiceKey(deps.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.log(`refused: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (!target.local && args.command !== "list" && !args.dryRun) {
    if (!deps.prompt) {
      deps.log(`refused: --env ${args.env} needs an interactive terminal for the typed confirmation`);
      return 2;
    }
    const phrase = confirmationPhrase(args, target);
    const typed = await deps.prompt(`This changes ${args.env} (${target.host}). Type exactly:\n  ${phrase}\n> `);
    if (typed.trim() !== phrase) {
      deps.log("refused: confirmation did not match; nothing was changed");
      return 2;
    }
  }

  const api = new Api(target, key, deps.fetch);
  const via = { via: "scripts/bootstrap-platform-admin.ts", env: args.env };

  if (args.command === "list") {
    for (const a of await api.admins()) deps.log(`platform admin ${a.user_id} since ${a.created_at}`);
    return 0;
  }

  const user = await api.userByEmail(args.email!);
  if (!user) {
    deps.log(`refused: no Auth user with email ${args.email} (the user must sign up first)`);
    return 3;
  }
  const admins = await api.admins();
  const isAdmin = admins.some((a) => a.user_id === user.id);

  if (args.command === "grant") {
    if (isAdmin) {
      deps.log(`no change: ${args.email} (${user.id}) is already a platform admin`);
      return 0;
    }
    if (args.dryRun) {
      deps.log(`dry run: would make ${args.email} (${user.id}) a platform admin`);
      return 0;
    }
    await api.call("POST", "/rest/v1/platform_admins", { user_id: user.id }, "resolution=ignore-duplicates,return=minimal");
    await api.audit("platform.admin_granted", null, { ...via, user_id: user.id, email: args.email });
    deps.log(`granted: ${args.email} (${user.id}) is a platform admin; console access needs an enrolled authenticator (AAL2)`);
    return 0;
  }

  if (args.command === "revoke") {
    if (!isAdmin) {
      deps.log(`no change: ${args.email} is not a platform admin`);
      return 0;
    }
    if (admins.length === 1) {
      deps.log("refused: this is the only platform admin; grant another first");
      return 4;
    }
    if (args.dryRun) {
      deps.log(`dry run: would remove platform admin ${args.email} (${user.id})`);
      return 0;
    }
    await api.call("DELETE", `/rest/v1/platform_admins?user_id=eq.${encodeURIComponent(user.id)}`, undefined, "return=minimal");
    await api.audit("platform.admin_revoked", args.reason, { ...via, user_id: user.id, email: args.email });
    deps.log(`revoked: ${args.email} (${user.id}) is no longer a platform admin`);
    return 0;
  }

  // remove-mfa
  const factors: Json[] = (await api.call("GET", `/auth/v1/admin/users/${user.id}/factors`)) ?? [];
  if (factors.length === 0) {
    deps.log(`no change: ${args.email} has no MFA factors`);
    return 0;
  }
  if (args.dryRun) {
    deps.log(`dry run: would remove ${factors.length} factor(s) from ${args.email}`);
    return 0;
  }
  for (const f of factors) await api.call("DELETE", `/auth/v1/admin/users/${user.id}/factors/${f.id}`);
  await api.audit("platform.mfa_factors_removed", args.reason, {
    ...via, user_id: user.id, email: args.email, factor_ids: factors.map((f) => f.id),
  });
  deps.log(`removed ${factors.length} factor(s) from ${args.email}; they must sign in and enrol a new authenticator`);
  return 0;
}

async function main(): Promise<void> {
  const { createInterface } = await import("node:readline/promises");
  const prompt = process.stdin.isTTY
    ? async (q: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(q);
        } finally {
          rl.close();
        }
      }
    : null;
  try {
    process.exitCode = await run(process.argv.slice(2), { env: process.env, fetch, log: (l) => console.log(l), prompt });
  } catch (err) {
    console.error(`failed: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

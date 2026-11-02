/**
 * Platform-admin bootstrap and operator tool (spec §6.4 A2, §20.4 item 4). CLI only.
 *
 *   tsx scripts/bootstrap-platform-admin.ts grant      --email <e> --env <local|staging|production> [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts revoke     --email <e> --env <...> --reason "<why>" [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts remove-mfa --email <e> --env <...> --reason "<why>" [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts end-sessions --email <e> --env <...> --reason "<why>" [--dry-run]
 *   tsx scripts/bootstrap-platform-admin.ts list       --env <...>
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment (never from arguments or
 * files, never printed). `--env local` only accepts a loopback URL. `--env staging|production`
 * only accepts an https, non-loopback URL, needs an interactive terminal, and the operator must
 * type the confirmation phrase shown. Every change is written to platform_audit_log.
 * `grant` and `revoke` call database functions (M22) that change platform_admins and write the
 * audit row in one transaction, serialized by one lock; the database refuses to remove the last
 * platform admin, whichever path tries.
 * MFA recovery: `remove-mfa` first ends every session of the account (M27: the session rows and
 * their refresh tokens are deleted with an audit row, and M21 refuses their access tokens at
 * once), then deletes the user's factors, so whoever holds the lost device is signed out and the
 * owner's next sign-in is AAL1 and must enrol a new authenticator before the console opens; there
 * are no recovery codes. The password is unchanged: if it may be known too, reset it as well.
 * `end-sessions` does only the first step (e.g. a stolen laptop, MFA kept).
 * Auth API deletions cannot share a transaction with the audit log, so `remove-mfa` writes a
 * start record first (nothing is changed if that fails), re-reads the factors afterwards, and
 * records the observed outcome: complete, partial, none, unknown, concurrent_factors, or
 * sessions_unknown (no factor is deleted without confirmed session termination). Only complete exits 0.
 * Resume with --operation-id <UUID>, the same email and reason. Zero factors still ends sessions
 * and records completion. Concurrent new factors are preserved and reported, never silently removed.
 */

export type TargetEnv = "local" | "staging" | "production";
export type Command = "grant" | "revoke" | "remove-mfa" | "end-sessions" | "list";
export type Args = { command: Command; email: string | null; env: TargetEnv; reason: string | null; dryRun: boolean; operationId?: string };
export type Target = { url: string; host: string; local: boolean };

export class UsageError extends Error {}

const COMMANDS: readonly Command[] = ["grant", "revoke", "remove-mfa", "end-sessions", "list"];
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
    if (!["email", "env", "reason", "dry-run", "operation-id"].includes(name)) throw new UsageError(`unknown option: ${a}`);
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
  if ((command === "revoke" || command === "remove-mfa" || command === "end-sessions") && (!reason || reason.length < 5 || reason.length > 500)) {
    throw new UsageError("--reason (5–500 characters) is required; it is written to the audit log");
  }
  const operationId = flags.get("operation-id");
  if (operationId !== undefined && (command !== "remove-mfa" || typeof operationId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId))) {
    throw new UsageError("--operation-id must be a UUID and is only valid with remove-mfa");
  }
  return { command: command as Command, email, env: env as TargetEnv, reason, dryRun: flags.get("dry-run") === true,
    ...(typeof operationId === "string" ? { operationId: operationId.toLowerCase() } : {}) };
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

/** A failed API call. Carries the HTTP status and PostgreSQL/PostgREST code, never response text. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly lastAdmin: boolean) {
    super(message);
  }
}

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
    if (!res.ok) {
      let body: Json = {};
      try {
        body = JSON.parse(text) ?? {};
      } catch {
        // non-JSON error body
      }
      const code = typeof body.code === "string" ? body.code : null;
      const lastAdmin = code === "23514" && String(body.message ?? "").startsWith("last_platform_admin");
      throw new ApiError(`${method} ${path.split("?")[0]} failed: HTTP ${res.status}${code ? ` (${code})` : ""}`, res.status, code, lastAdmin);
    }
    return text ? JSON.parse(text) : null;
  }

  rpc(fn: string, args: Json): Promise<any> {
    return this.call("POST", `/rest/v1/rpc/${fn}`, args);
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

  /** M27: deletes the user's Auth sessions (and refresh tokens) together with an audit row. */
  async endSessions(userId: string, reason: string, metadata: Json): Promise<{ ended: number }> {
    const r = await this.rpc("platform_end_user_sessions", { p_user_id: userId, p_reason: reason, p_metadata: metadata });
    if (!Number.isSafeInteger(r?.ended) || r.ended < 0) throw new Error("Invalid session-ending response; outcome unknown");
    return { ended: r.ended };
  }

  async operationRows(userId: string, operationId: string, action: string): Promise<unknown[]> {
    const query = new URLSearchParams({ select: "reason,metadata", action: `eq.${action}`,
      "metadata->>user_id": `eq.${userId}`, "metadata->>operation_id": `eq.${operationId}`, order: "id.desc", limit: "1" });
    const rows: unknown = await this.call("GET", `/rest/v1/platform_audit_log?${query}`);
    if (!Array.isArray(rows)) throw new Error("Invalid operation audit response");
    return rows;
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
  if (args.command === "grant" || args.command === "revoke") {
    if (args.dryRun) {
      const admins = await api.admins();
      const isAdmin = admins.some((a) => a.user_id === user.id);
      if (args.command === "grant") {
        deps.log(isAdmin ? `dry run: no change, ${args.email} is already a platform admin` : `dry run: would make ${args.email} (${user.id}) a platform admin`);
      } else if (!isAdmin) {
        deps.log(`dry run: no change, ${args.email} is not a platform admin`);
      } else {
        deps.log(admins.length <= 1
          ? "dry run: would be refused, this is the only platform admin"
          : `dry run: would remove platform admin ${args.email} (${user.id})`);
      }
      return 0;
    }
    const metadata = { ...via, email: args.email };
    if (args.command === "grant") {
      const r = await api.rpc("platform_admin_grant", { p_user_id: user.id, p_metadata: metadata });
      deps.log(r?.changed
        ? `granted: ${args.email} (${user.id}) is a platform admin; console access needs an enrolled authenticator (AAL2)`
        : `no change: ${args.email} (${user.id}) is already a platform admin`);
      return 0;
    }
    try {
      const r = await api.rpc("platform_admin_revoke", { p_user_id: user.id, p_reason: args.reason, p_metadata: metadata });
      deps.log(r?.changed ? `revoked: ${args.email} (${user.id}) is no longer a platform admin` : `no change: ${args.email} is not a platform admin`);
      return 0;
    } catch (err) {
      if (err instanceof ApiError && err.lastAdmin) {
        deps.log("refused: this is the only platform admin; grant another first (nothing was changed)");
        return 4;
      }
      throw err;
    }
  }

  if (args.command === "end-sessions") {
    if (args.dryRun) {
      deps.log(`dry run: would end every session of ${args.email} (${user.id})`);
      return 0;
    }
    const r = await api.endSessions(user.id, args.reason!, { ...via, email: args.email });
    deps.log(`ended ${r.ended} session(s) of ${args.email}; every device must sign in again`);
    return 0;
  }

  return removeMfa(api, args, user.id, via, deps);
}

function factorIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v: unknown) => !v || typeof v !== "object"
      || !("id" in v) || typeof v.id !== "string" || !v.id)) throw new Error("Invalid factor-list response");
  const ids = value.map((v: { id: string }) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate factor IDs in response");
  return ids;
}

function auditRecord(value: unknown): { reason: string; metadata: Record<string, unknown> } {
  if (!value || typeof value !== "object" || !("reason" in value) || typeof value.reason !== "string"
      || !("metadata" in value) || !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) {
    throw new Error("Invalid operation audit record");
  }
  return { reason: value.reason, metadata: value.metadata as Record<string, unknown> };
}

/** Exit codes: 0 complete; 5 some or all factors remain, or the outcome could not be confirmed;
 *  6 the factors were removed but the completion record could not be written. */
async function removeMfa(api: Api, args: Args, userId: string, via: Json, deps: Deps): Promise<number> {
  const factorsUrl = `/auth/v1/admin/users/${userId}/factors`;
  const currentIds = factorIds(await api.call("GET", factorsUrl));
  let ids = currentIds;
  const operationId = args.operationId ?? globalThis.crypto.randomUUID();
  if (args.operationId) {
    const rows = await api.operationRows(userId, operationId, "platform.mfa_removal_started");
    if (rows.length !== 1) throw new Error("Recovery operation not found for this user; nothing was changed");
    const start = auditRecord(rows[0]);
    if (start.reason !== args.reason || !Array.isArray(start.metadata.factor_ids)
        || start.metadata.factor_ids.some((id: unknown) => typeof id !== "string" || !id)) {
      throw new Error("Recovery operation reason or factor IDs do not match; nothing was changed");
    }
    ids = start.metadata.factor_ids as string[];
  }
  if (args.dryRun) {
    deps.log(`dry run: would end every session of ${args.email} and remove the original ${ids.length} factor(s)`);
    return 0;
  }
  const base = { ...via, operation_id: operationId, user_id: userId, email: args.email, factor_ids: ids };
  deps.log(`recovery operation ${operationId}; retry with the same email/reason and --operation-id ${operationId}`);
  if (!args.operationId) {
    try {
      await api.audit("platform.mfa_removal_started", args.reason, base);
    } catch {
      deps.log(`refused: the start record could not be confirmed; no sessions or factors were changed (operation ${operationId}); reconcile before retrying`);
      return 1;
    }
  }

  let sessionsEnded: number;
  try {
    // A retry ends sessions again, including any created since the previous attempt.
    sessionsEnded = (await api.endSessions(userId, args.reason!, { ...via, operation_id: operationId, email: args.email })).ended;
  } catch {
    // Absence of a row does NOT prove rollback: the request might still be committing.
    // A matching committed audit row, however, proves this atomic RPC ended sessions.
    let committed: number | null = null;
    try {
      // Resumed operations may have earlier successful attempts. Never use their row to
      // certify the current request: a new session might have been created since then.
      if (!args.operationId) {
        const rows = await api.operationRows(userId, operationId, "platform.sessions_ended");
        if (rows.length === 1) {
          const row = auditRecord(rows[0]);
          const ended = row.metadata.sessions_ended;
          if (row.reason === args.reason && typeof ended === "number" && Number.isSafeInteger(ended) && ended >= 0) committed = ended;
        }
      }
    } catch { /* Audit lookup unavailable: preserve uncertainty and do not delete factors. */ }
    if (committed !== null) {
      sessionsEnded = committed;
    } else {
      let recorded = true;
      try {
        await api.audit("platform.mfa_removal_incomplete", args.reason, {
          ...base, outcome: "sessions_unknown", removed_factor_ids: [], remaining_factor_ids: currentIds, failed_calls: 1,
        });
      } catch { recorded = false; }
      deps.log(`incomplete: session-ending outcome is unknown; no factor was removed${recorded ? "" : "; the outcome record could not be written either"} (operation ${operationId})`);
      return 5;
    }
  }

  let failedCalls = 0;
  for (const id of ids) {
    if (!currentIds.includes(id)) continue;
    try {
      await api.call("DELETE", `${factorsUrl}/${encodeURIComponent(id)}`);
    } catch {
      failedCalls += 1;
    }
  }
  let remaining: string[] | null = null;
  try {
    remaining = factorIds(await api.call("GET", factorsUrl));
  } catch {
    remaining = null;
  }
  const removed = remaining ? ids.filter((id) => !remaining!.includes(id)) : [];
  const added = remaining?.filter((id) => !ids.includes(id)) ?? [];
  const outcome = remaining === null ? "unknown" : added.length > 0 ? "concurrent_factors"
    : remaining.length === 0 ? "complete" : removed.length === 0 ? "none" : "partial";
  const action = outcome === "complete" ? "platform.mfa_factors_removed" : "platform.mfa_removal_incomplete";

  let recorded = true;
  try {
    await api.audit(action, args.reason, {
      ...base, outcome, sessions_ended: sessionsEnded, removed_factor_ids: removed, remaining_factor_ids: remaining,
      new_factor_ids: added, failed_calls: failedCalls,
    });
  } catch {
    recorded = false;
  }

  if (outcome === "complete") {
    if (!recorded) {
      deps.log(`removed ${ids.length} factor(s) from ${args.email}, but the completion record could not be confirmed; start and session-ending records exist (operation ${operationId}); retry with --operation-id ${operationId}`);
      return 6;
    }
    deps.log(`ended ${sessionsEnded} session(s) and removed ${ids.length} factor(s) from ${args.email}; they must sign in and enrol a new authenticator`);
    return 0;
  }
  const detail = outcome === "unknown"
    ? `the factors could not be re-read after ${failedCalls} failed deletion(s); the outcome is unknown, check before retrying`
    : outcome === "concurrent_factors" ? "new factors appeared during recovery; they were preserved; review before starting a new operation"
    : `removed ${removed.length} of ${ids.length} factor(s); still present: ${remaining!.join(", ")}`;
  deps.log(`incomplete: ${detail}${recorded ? "" : "; the outcome record could not be written either"} (operation ${base.operation_id})`);
  return 5;
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

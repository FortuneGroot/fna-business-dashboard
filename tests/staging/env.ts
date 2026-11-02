// Shared guards and synthetic-identity helpers for the staging checks in tests/staging/. Every check
// refuses unless SUPABASE_URL is https on STAGING_PROJECT_REF, that ref is not production, the
// database URL belongs to the same project, the app is local, and staging holds only "(synthetic)"
// workspaces. Accounts are created only for @example.test addresses. Keys are never printed.
import assert from "node:assert/strict";
import pg from "pg";
import { appFetch, totp, type App, type StackEnv } from "../supabase-stack/stack";

export const PRODUCTION_REFS = new Set(["rbghfpwbwmrjbpjswbbn"]);

export type Staging = { env: StackEnv; db: pg.Client; app: App; ref: string };
export type Account = { id: string; email: string; password: string };

export async function connectStaging(): Promise<Staging> {
  assert.equal(process.env.STAGING_REHEARSAL, "1", "set STAGING_REHEARSAL=1 to run against staging");
  const url = new URL((process.env.SUPABASE_URL ?? "").trim());
  const ref = (process.env.STAGING_PROJECT_REF ?? "").trim();
  assert.equal(url.protocol, "https:", "staging must be https");
  assert.equal(url.hostname, `${ref}.supabase.co`, "SUPABASE_URL must be the STAGING_PROJECT_REF project");
  assert.ok(ref && !PRODUCTION_REFS.has(ref), "refusing the production project");
  const dbUrl = (process.env.STAGING_DB_URL ?? "").trim();
  assert.ok(dbUrl.includes(ref) && ![...PRODUCTION_REFS].some((p) => dbUrl.includes(p)), "STAGING_DB_URL must belong to the same project");
  const appUrl = new URL((process.env.STAGING_APP_URL ?? "").trim());
  assert.ok(["localhost", "127.0.0.1"].includes(appUrl.hostname), "the app must be local");
  const env: StackEnv = {
    apiUrl: url.origin, dbUrl, anonKey: (process.env.SUPABASE_ANON_KEY ?? "").trim(),
    serviceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim(), jwtSecret: "",
  };
  assert.ok(env.anonKey && env.serviceRoleKey, "keys are set");
  const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const foreign = await db.query<{ n: number }>("select count(*)::int n from public.workspaces where name not like '%(synthetic)'");
  assert.equal(foreign.rows[0].n, 0, "staging holds a non-synthetic workspace; refusing");
  const app: App = { url: appUrl.origin, stop: () => undefined, outbound: () => [], log: () => "" };
  const health = await appFetch(app, "/api/health");
  assert.deepEqual([health.status, health.body?.authProvider, health.body?.db], [200, "supabase", "ok"], "app health");
  return { env, db, app, ref };
}

const serviceHeaders = (env: StackEnv) => ({ apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}`, "Content-Type": "application/json" });

/** A confirmed synthetic account made through the Auth admin API (public sign-up is off on staging). */
export async function createAccount(env: StackEnv, email: string, password: string, fullName: string): Promise<Account> {
  assert.ok(email.endsWith("@example.test"), "synthetic addresses only");
  const r = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
    method: "POST", headers: serviceHeaders(env),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
  });
  const body: any = await r.json().catch(() => null);
  assert.equal(r.status, 200, `create ${email}: ${r.status} ${JSON.stringify(body?.code ?? body?.error_code ?? null)}`);
  return { id: body.id, email, password };
}

/** GoTrue password grant; returns the access token. */
export async function passwordToken(env: StackEnv, a: { email: string; password: string }): Promise<string> {
  const r = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: env.anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email: a.email, password: a.password }),
  });
  const body: any = await r.json().catch(() => null);
  assert.equal(r.status, 200, `sign-in ${a.email}: ${r.status}`);
  return body.access_token;
}

/** Enrols and verifies TOTP through GoTrue; returns the AAL2 access token and the factor secret. */
export async function enrolTotp(env: StackEnv, token: string): Promise<{ token: string; secret: string; factorId: string }> {
  const auth = { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const en: any = await (await fetch(`${env.apiUrl}/auth/v1/factors`, {
    method: "POST", headers: auth, body: JSON.stringify({ factor_type: "totp", friendly_name: "staging-synthetic" }),
  })).json();
  assert.ok(en?.id && en?.totp?.secret, "TOTP enrolment");
  return { ...(await verifyTotp(env, token, en.id, en.totp.secret)), secret: en.totp.secret, factorId: en.id };
}

export async function verifyTotp(env: StackEnv, token: string, factorId: string, secret: string): Promise<{ token: string }> {
  const auth = { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const ch: any = await (await fetch(`${env.apiUrl}/auth/v1/factors/${factorId}/challenge`, { method: "POST", headers: auth, body: "{}" })).json();
  const v = await fetch(`${env.apiUrl}/auth/v1/factors/${factorId}/verify`, {
    method: "POST", headers: auth, body: JSON.stringify({ challenge_id: ch.id, code: totp(secret) }),
  });
  const body: any = await v.json().catch(() => null);
  assert.equal(v.status, 200, `TOTP verify: ${v.status}`);
  return { token: body.access_token };
}

/** A synthetic platform admin (audited grant) at AAL2. Revoke it with revokeAdmin when finished. */
export async function syntheticAdmin(s: Staging, email: string, password: string, via: string) {
  const account = await createAccount(s.env, email, password, "Staging Platform Admin (synthetic)");
  await s.db.query("select public.platform_admin_grant($1, $2)", [account.id, { via }]);
  const aal2 = await enrolTotp(s.env, await passwordToken(s.env, account));
  return { ...account, aal2: aal2.token };
}

export async function revokeAdmin(s: Staging, id: string, reason: string) {
  await s.db.query("select public.platform_admin_revoke($1, $2, $3)", [id, reason, {}]).catch(() => undefined);
}

/** Provisions a "(synthetic)" workspace for an existing synthetic owner and accepts the owner invitation. */
export async function provision(s: Staging, adminAal2: string, owner: Account, key: string, name: string): Promise<string> {
  assert.ok(name.endsWith("(synthetic)"), "synthetic workspaces only");
  const call = (fn: string, token: string, args: Record<string, unknown>) => fetch(`${s.env.apiUrl}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: s.env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as any }));
  const prov = await call("platform_provision_workspace", adminAal2, { p_provisioning_key: key, p_name: name, p_slug: key, p_owner_email: owner.email });
  assert.equal(prov.status, 200, `provision ${name}`);
  const accepted = await call("accept_invitation", await passwordToken(s.env, owner), { p_token: prov.body.invite_token });
  assert.equal(accepted.status, 200, `accept ${name}`);
  return prov.body.workspace_id;
}

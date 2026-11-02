// Hosted backup and restore rehearsal (not part of any suite). Exports the staging project with the
// explicit, plan-independent procedure in docs/BACKUP_RESTORE_REHEARSAL.md, then restores it into a
// separate, empty, local disposable stack and proves the copy is faithful:
//   database   `supabase db dump` roles / schema / data (auth, public, private, storage metadata) /
//              migration-history schema and rows
//   managed    policies and triggers the app adds to Supabase-owned tables (storage.objects,
//              auth.users), which `db dump` leaves out, re-created from pg_policies / pg_get_triggerdef
//   files      every workspace-assets object downloaded through the Storage API with its sha256
// The export holds password hashes and MFA secrets, so it lives only in the OS temp directory and is
// deleted at the end. Only synthetic data is created; George's account is compared by fingerprint
// only and never signed in.
//
//   STAGING_REHEARSAL=1 STAGING_PROJECT_REF=... STAGING_APP_URL=http://localhost:3000 (+ staging keys)
//   node --require ./scripts/stub-server-only.cjs --import tsx --test --test-concurrency=1 tests/staging/backup-restore.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { adminDb, appFetch, appLogin, rest, stackDocker, startStack, storage, type Stack } from "../supabase-stack/stack";
import { connectStaging, createAccount, enrolTotp, passwordToken, provision, revokeAdmin, syntheticAdmin, verifyTotp, type Account, type Staging } from "./env";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "node_modules", "supabase", "dist", "supabase.js");
const BUCKET = "workspace-assets";
const GEORGE = "gnassar90@gmail.com";
const run = Date.now().toString(36);

let s: Staging;
let target: Stack | undefined;
let targetDb: pg.Client | undefined;
let adminId = "";
let owner: Account;
let mfa: { secret: string; factorId: string; token: string };
let ws = "";
let logo = "";
const logoText = `Backup Bakery synthetic logo ${run}`;
const dir = mkdtempSync(join(tmpdir(), "fna-hosted-backup-"));
const notes: string[] = [];

// ---------------------------------------------------------------------------------------------
// Fingerprints compared between the source and the restored copy (names, counts, md5s only).
// ---------------------------------------------------------------------------------------------
const CATALOG: Record<string, string> = {
  policies: `select schemaname||'.'||tablename||'.'||policyname||' '||cmd||' '||permissive||' '||array_to_string(roles,',')||' '||coalesce(qual,'')||' '||coalesce(with_check,'') v
             from pg_policies where schemaname in ('public','private','storage') order by 1`,
  rls: `select n.nspname||'.'||c.relname||' rls='||c.relrowsecurity||' force='||c.relforcerowsecurity v from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','private') and c.relkind in ('r','p') order by 1`,
  relationOwners: `select n.nspname||'.'||c.relname||' '||c.relkind::text||' '||pg_get_userbyid(c.relowner) v from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','S','f') order by 1`,
  functions: `select p.oid::regprocedure::text||' owner='||pg_get_userbyid(p.proowner)||' secdef='||p.prosecdef||' cfg='||coalesce(array_to_string(p.proconfig,','),'')
                ||' acl='||coalesce(array_to_string(array(select x::text from unnest(p.proacl) x order by 1),','),'')||' src='||md5(p.prosrc) v
              from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace) order by 1`,
  tableGrants: `select table_schema||'.'||table_name||' '||grantee||' '||privilege_type v from information_schema.role_table_grants
                where table_schema in ('public','private') order by 1`,
  triggers: `select c.relnamespace::regnamespace::text||'.'||c.relname||' '||t.tgname||' enabled='||t.tgenabled::text||' '||md5(pg_get_triggerdef(t.oid)) v
             from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc f on f.oid=t.tgfoid
             where not t.tgisinternal and (c.relnamespace in ('public'::regnamespace,'private'::regnamespace) or f.pronamespace in ('public'::regnamespace,'private'::regnamespace)) order by 1`,
  schemaAcl: `select nspname||' '||coalesce(array_to_string(array(select x::text from unnest(nspacl) x order by 1),','),'') v from pg_namespace
              where nspname in ('public','private') order by 1`,
  defaultAcl: `select pg_get_userbyid(d.defaclrole)||' '||coalesce(d.defaclnamespace::regnamespace::text,'*')||' '||d.defaclobjtype::text||' '||array_to_string(array(select x::text from unnest(d.defaclacl) x order by 1),',') v
               from pg_default_acl d where d.defaclnamespace in ('public'::regnamespace,'private'::regnamespace) and pg_get_userbyid(d.defaclrole) = 'postgres' order by 1`,
  roleSettings: `select rolname||' '||coalesce(array_to_string(array(select x from unnest(rolconfig) x order by 1),','),'') v from pg_roles
                 where rolname in ('anon','authenticated','authenticator','service_role') order by 1`,
  buckets: `select id||' public='||public||' limit='||coalesce(file_size_limit::text,'-')||' mimes='||coalesce(array_to_string(allowed_mime_types,','),'-') v from storage.buckets order by 1`,
  migrationHistory: `select version||' '||coalesce(name,'') v from supabase_migrations.schema_migrations order by 1`,
};
const AUTH_DIGESTS: Record<string, string> = {
  "auth.users": `select concat_ws(',', id, email, encrypted_password, email_confirmed_at, raw_user_meta_data::text, raw_app_meta_data::text, is_sso_user, banned_until, deleted_at) x from auth.users`,
  "auth.identities": `select concat_ws(',', id, user_id, provider, provider_id, identity_data::text) x from auth.identities`,
  "auth.mfa_factors": `select concat_ws(',', id, user_id, status, factor_type, secret, friendly_name) x from auth.mfa_factors`,
  "storage.objects": `select concat_ws(',', id, bucket_id, name, owner, owner_id, version, metadata->>'size', metadata->>'mimetype') x from storage.objects`,
};

async function catalog(db: pg.Client) {
  const out: Record<string, string[]> = {};
  for (const [k, sql] of Object.entries(CATALOG)) out[k] = (await db.query<{ v: string }>(sql)).rows.map((r) => r.v);
  return out;
}

async function dataDigests(db: pg.Client, tables: string[]) {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const r = await db.query<{ n: number; d: string }>(`select count(*)::int n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') d from ${t} t`);
    out[t] = `${r.rows[0].n} ${r.rows[0].d}`;
  }
  for (const [t, sql] of Object.entries(AUTH_DIGESTS)) {
    const r = await db.query<{ n: number; d: string }>(`select count(*)::int n, coalesce(md5(string_agg(x, '|' order by x)), '') d from (${sql}) s`);
    out[t] = `${r.rows[0].n} ${r.rows[0].d}`;
  }
  return out;
}

const georgeFingerprint = async (db: pg.Client) => (await db.query<{ f: string | null }>(
  `select md5(concat_ws(',', u.id, u.encrypted_password, u.email_confirmed_at,
     (select string_agg(concat_ws(':', f.id, f.status, f.secret), ',' order by f.id) from auth.mfa_factors f where f.user_id = u.id),
     exists (select 1 from public.platform_admins a where a.user_id = u.id),
     exists (select 1 from public.profiles p where p.user_id = u.id))) f
   from auth.users u where u.email = $1`, [GEORGE])).rows[0]?.f ?? null;

function diff(label: string, a: string[], b: string[]) {
  const missing = a.filter((x) => !b.includes(x));
  const extra = b.filter((x) => !a.includes(x));
  return missing.length || extra.length
    ? [`${label}: ${missing.length} missing, ${extra.length} extra`, ...missing.slice(0, 5).map((x) => `  - ${x.slice(0, 160)}`), ...extra.slice(0, 5).map((x) => `  + ${x.slice(0, 160)}`)]
    : [];
}

function cli(args: string[], timeoutMs = 600_000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  const scrub = (t: string) => t.split(s.env.dbUrl).join("<redacted>");
  assert.equal(r.status, 0, `supabase ${args[0]} ${args[1]} failed: ${scrub(`${r.stderr}${r.stdout}`).trim().split(/\r?\n/).slice(-6).join(" | ")}`);
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
let sourceCatalog: Record<string, string[]>;
let sourceData: Record<string, string>;
let sourceGeorge: string | null;
let tables: string[] = [];
let files: { name: string; version: string; sha256: string; bytes: number }[] = [];

describe("hosted backup and restore: explicit database + Storage export restored into a separate disposable stack", () => {
  before(async () => {
    s = await connectStaging();
    const admin = await syntheticAdmin(s, `backup-platform-${run}@example.test`, `Stg-backup-admin-${run}-Aa1!`, "tests/staging/backup-restore.test.ts");
    adminId = admin.id;
    owner = await createAccount(s.env, `backup-owner-${run}@example.test`, `Stg-backup-owner-${run}-Aa1!`, "Bianca Backup (synthetic)");
    ws = await provision(s, admin.aal2, owner, `synthetic-backup-${run}`, "Backup Bakery (synthetic)");
    const cookie = await appLogin(s.app, { ...owner, token: "" });
    for (const [firstName, lastName] of [["Rita", "Rye"], ["Sam", "Sourdough"], ["Ola", "Oat"]]) {
      const r = await appFetch(s.app, "/api/contacts", { method: "POST", cookie, json: { firstName, lastName, tags: ["backup"] } });
      assert.equal(r.status, 200, `contact ${firstName}: ${r.status}`);
    }
    mfa = await enrolTotp(s.env, await passwordToken(s.env, owner));
    logo = `${ws}/logo-${run}.txt`;
    const up = await storage(s.env, mfa.token, "POST", `${BUCKET}/${logo}`, logoText);
    assert.equal(up.status, 200, `logo upload: ${up.status} ${up.text.slice(0, 200)}`);
  });

  after(async () => {
    if (notes.length) console.log(`\nhosted backup/restore\n${notes.join("\n")}\n`);
    await targetDb?.end().catch(() => undefined);
    target?.stop();
    rmSync(dir, { recursive: true, force: true });
    if (s) {
      await revokeAdmin(s, adminId, "staging backup rehearsal finished");
      await s.db.end().catch(() => undefined);
    }
  });

  test("export: roles, schema, data, migration history, managed-schema policies/triggers, Storage files", async () => {
    const started = performance.now();
    tables = (await s.db.query<{ t: string }>(
      `select quote_ident(n.nspname)||'.'||quote_ident(c.relname) t from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname in ('public','private') and c.relkind in ('r','p') order by 1`)).rows.map((r) => r.t);
    sourceCatalog = await catalog(s.db);
    sourceData = await dataDigests(s.db, tables);
    sourceGeorge = await georgeFingerprint(s.db);
    assert.ok(sourceGeorge, "George's account is on staging");

    const url = s.env.dbUrl;
    cli(["db", "dump", "--db-url", url, "--role-only", "-f", join(dir, "roles.sql")]);
    cli(["db", "dump", "--db-url", url, "-f", join(dir, "schema.sql")]);
    cli(["db", "dump", "--db-url", url, "--data-only", "--use-copy", "-f", join(dir, "data.sql")]);
    cli(["db", "dump", "--db-url", url, "--schema", "supabase_migrations", "-f", join(dir, "history_schema.sql")]);
    cli(["db", "dump", "--db-url", url, "--data-only", "--use-copy", "--schema", "supabase_migrations", "-f", join(dir, "history_data.sql")]);

    const schema = readFileSync(join(dir, "schema.sql"), "utf8");
    const managedPolicies = (await s.db.query<{ sql: string; name: string }>(
      `select schemaname||'.'||tablename||'.'||policyname name,
              format('create policy %I on %I.%I as %s for %s to %s%s%s;', policyname, schemaname, tablename, permissive, cmd,
                     array_to_string(array(select quote_ident(r) from unnest(roles) r), ', '),
                     case when qual is not null then ' using (' || qual || ')' else '' end,
                     case when with_check is not null then ' with check (' || with_check || ')' else '' end) sql
       from pg_policies where schemaname in ('storage','auth') order by 1`)).rows;
    const managedTriggers = (await s.db.query<{ sql: string; name: string }>(
      `select c.relnamespace::regnamespace::text||'.'||c.relname||'.'||t.tgname name, pg_get_triggerdef(t.oid) || ';' sql
       from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc f on f.oid=t.tgfoid
       where not t.tgisinternal and c.relnamespace in ('storage'::regnamespace,'auth'::regnamespace)
         and f.pronamespace in ('public'::regnamespace,'private'::regnamespace) order by 1`)).rows;
    const missingFromDump = [...managedPolicies, ...managedTriggers].filter((o) => !schema.includes(`"${o.name.split(".").pop()}"`));
    writeFileSync(join(dir, "managed.sql"), [...managedPolicies, ...managedTriggers].map((o) => o.sql).join("\n") + "\n");
    notes.push(`db dump leaves out ${missingFromDump.length} app objects on Supabase-owned tables (exported separately): ${missingFromDump.map((o) => o.name).join(", ")}`);

    const objects = (await s.db.query<{ name: string; version: string }>(
      "select name, version from storage.objects where bucket_id = $1 order by name", [BUCKET])).rows;
    assert.ok(objects.some((o) => o.name === logo), "the synthetic logo is in the bucket");
    files = [];
    for (const o of objects) {
      const r = await fetch(`${s.env.apiUrl}/storage/v1/object/${BUCKET}/${o.name.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { apikey: s.env.serviceRoleKey, Authorization: `Bearer ${s.env.serviceRoleKey}` },
      });
      assert.equal(r.status, 200, `download ${o.name}: ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const local = join(dir, "storage", ...o.name.split("/"));
      mkdirSync(dirname(local), { recursive: true });
      writeFileSync(local, bytes);
      files.push({ name: o.name, version: o.version, sha256: sha256(bytes), bytes: bytes.length });
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), files, tables: tables.length }, null, 2));
    const size = (f: string) => statSync(join(dir, f)).size;
    notes.push(`export in ${Math.round(performance.now() - started)} ms: roles ${size("roles.sql")} B, schema ${size("schema.sql")} B, data ${size("data.sql")} B, history ${size("history_data.sql")} B, managed ${size("managed.sql")} B, ${files.length} Storage file(s)`);
    for (const f of ["roles.sql", "schema.sql", "data.sql", "history_schema.sql", "history_data.sql"]) assert.ok(size(f) > 0, `${f} written`);
    assert.ok(readFileSync(join(dir, "data.sql"), "utf8").includes("COPY \"auth\".\"mfa_factors\""), "Auth (including MFA factors) is in the data dump");
  });

  test("restore: into an empty disposable stack (no app migrations), one transaction, then Storage files", async () => {
    const started = performance.now();
    const empty = join(dir, "empty-project");
    mkdirSync(join(empty, "migrations"), { recursive: true });
    copyFileSync(join(ROOT, "supabase", "config.toml"), join(empty, "config.toml"));
    target = startStack(3000, empty);
    targetDb = await adminDb(target.env);
    assert.equal((await targetDb.query<{ n: number }>("select count(*)::int n from pg_tables where schemaname = 'public'")).rows[0].n, 0, "target starts with no app tables");

    // Platform-managed roles (for example supabase_realtime_admin) exist only on hosted projects; a
    // role statement naming one is skipped and reported rather than failing the whole restore.
    const targetRoles = new Set((await targetDb.query<{ r: string }>("select rolname r from pg_roles")).rows.map((x) => x.r));
    const roleLines = readFileSync(join(dir, "roles.sql"), "utf8").split(/\r?\n/);
    for (const l of roleLines) for (const m of l.matchAll(/^CREATE ROLE "([^"]+)"/g)) targetRoles.add(m[1]);
    const skipped = roleLines.filter((l) => [...l.matchAll(/(?:ROLE|TO) "([^"]+)"/g)].some((m) => !targetRoles.has(m[1])));
    notes.push(`roles: ${skipped.length} statement(s) name a hosted-only platform role and were skipped: ${skipped.join(" ; ")}`);
    const parts = ["\\set ON_ERROR_STOP on", "begin;", "drop schema if exists supabase_migrations cascade;"];
    parts.push(roleLines.filter((l) => !skipped.includes(l)).join("\n"));
    const schema = readFileSync(join(dir, "schema.sql"), "utf8");
    parts.push(schema, readFileSync(join(dir, "history_schema.sql"), "utf8"));
    // The target's default privileges (Supabase grants new objects to anon/authenticated/service_role)
    // apply while schema.sql creates each object, and pg_dump never revokes them. Reset those roles'
    // object privileges, then re-apply exactly the dump's own GRANT/REVOKE statements.
    const acl = schema.split(/\r?\n/).filter((l) => /^(GRANT|REVOKE) /.test(l));
    writeFileSync(join(dir, "acl.sql"), acl.join("\n") + "\n");
    for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      parts.push(`revoke all on all ${kind} in schema public, private from anon, authenticated, service_role;`);
    }
    parts.push(acl.join("\n"));
    parts.push("set session_replication_role = replica;");
    for (const f of ["data.sql", "history_data.sql"]) parts.push(readFileSync(join(dir, f), "utf8"));
    parts.push("set session_replication_role = origin;", readFileSync(join(dir, "managed.sql"), "utf8"), "commit;");
    stackDocker(target, "db", (c) => ["exec", "-i", c, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", "-f", "-"], parts.join("\n"), 900_000);
    await targetDb.query("notify pgrst, 'reload schema'");

    const probe = `probe-${run}.txt`;
    const up = await fetch(`${target.env.apiUrl}/storage/v1/object/${BUCKET}/${probe}`, {
      method: "POST", headers: { apikey: target.env.serviceRoleKey, Authorization: `Bearer ${target.env.serviceRoleKey}`, "Content-Type": "text/plain" }, body: "probe",
    });
    assert.equal(up.status, 200, `probe upload to the restored bucket: ${up.status}`);
    const found = stackDocker(target, "storage", (c) => ["exec", c, "sh", "-c", "find /mnt /var/lib/storage -type f 2>/dev/null || true"])
      .split(/\r?\n/).find((f) => f.includes(`/${BUCKET}/${probe}`));
    assert.ok(found, "probe file located in the storage container");
    const root = found.slice(0, found.indexOf(`/${BUCKET}/`));
    await fetch(`${target.env.apiUrl}/storage/v1/object/${BUCKET}/${probe}`, {
      method: "DELETE", headers: { apikey: target.env.serviceRoleKey, Authorization: `Bearer ${target.env.serviceRoleKey}` },
    });
    for (const f of files) {
      const inside = `${root}/${BUCKET}/${f.name}/${f.version}`;
      stackDocker(target, "storage", (c) => ["exec", "-u", "0", c, "mkdir", "-p", inside.slice(0, inside.lastIndexOf("/"))]);
      stackDocker(target, "storage", (c) => ["cp", join(dir, "storage", ...f.name.split("/")), `${c}:${inside}`]);
    }
    notes.push(`restore (stack start + database + files) in ${Math.round(performance.now() - started)} ms`);
  });

  test("restored catalog matches: policies, RLS, ownership, grants, functions, triggers, role settings, bucket, migration history", async () => {
    assert.ok(targetDb);
    const restored = await catalog(targetDb);
    const problems = Object.keys(CATALOG).flatMap((k) => diff(k, sourceCatalog[k], restored[k]));
    notes.push(`catalog: ${Object.entries(sourceCatalog).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  test("restored rows match: every public/private table, Auth users/identities/MFA factors, Storage metadata; George by fingerprint", async () => {
    assert.ok(targetDb);
    const restored = await dataDigests(targetDb, tables);
    const problems = Object.keys(sourceData).filter((t) => sourceData[t] !== restored[t])
      .map((t) => `${t}: source ${sourceData[t].split(" ")[0]} rows, restored ${restored[t]?.split(" ")[0] ?? "missing"} rows${sourceData[t].split(" ")[0] === restored[t]?.split(" ")[0] ? " (content differs)" : ""}`);
    const rows = Object.values(sourceData).reduce((n, v) => n + Number(v.split(" ")[0]), 0);
    notes.push(`data: ${Object.keys(sourceData).length} tables / ${rows} rows compared by md5`);
    assert.deepEqual(problems, [], problems.join("\n"));
    assert.equal(await georgeFingerprint(targetDb), sourceGeorge, "George's account, MFA factor, admin and profile rows restored unchanged");
  });

  test("restored copy works: original password + original authenticator, RLS-scoped rows, private logo bytes, old tokens rejected", async () => {
    assert.ok(target);
    const env = target.env;
    const aal1 = await passwordToken(env, owner);
    const { token } = await verifyTotp(env, aal1, mfa.factorId, mfa.secret);
    const visible = await rest(env, token, "GET", "workspaces?select=id,name");
    assert.equal(visible.status, 200);
    assert.deepEqual(visible.body.map((w: { id: string }) => w.id), [ws], "the restored owner sees only their own workspace");
    const contacts = await rest(env, token, "GET", "contacts?select=first_name&order=first_name");
    assert.deepEqual(contacts.body.map((c: { first_name: string }) => c.first_name), ["Ola", "Rita", "Sam"], "RLS returns exactly this workspace's contacts");
    const file = await storage(env, token, "GET", `${BUCKET}/${logo}`);
    assert.deepEqual([file.status, sha256(file.text)], [200, sha256(logoText)], "logo restored byte for byte, readable by its owner");
    assert.notEqual((await storage(env, null, "GET", `${BUCKET}/${logo}`)).status, 200, "logo stays private to anonymous callers");
    assert.equal((await rest(env, mfa.token, "GET", "workspaces?select=id")).status, 401, "a staging-issued token is not accepted by the restored copy");
    notes.push("sign-in on the restored copy: original password + original TOTP secret -> AAL2; RLS and Storage policies enforced; staging tokens rejected (new signing key)");
  });
});

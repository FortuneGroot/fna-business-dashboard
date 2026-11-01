// Synthetic backup and restore between two disposable stacks (hardening packet 5). Table rows are
// exported as JSON with credential columns blanked and session/MFA tables left out; Storage object
// files are copied out of the storage container. A restore writes into a different, freshly migrated
// stack as its superuser with triggers suspended, so restored rows are byte-for-byte the source rows
// and no restore-time audit or activity rows are invented.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type pg from "pg";
import { stackDocker, type Stack } from "./stack";

/** Never exported: sessions, refresh tokens, MFA secrets, one-time tokens, Auth's own audit trail. */
export const EXCLUDED_TABLES = [
  "auth.sessions", "auth.refresh_tokens", "auth.mfa_factors", "auth.mfa_challenges", "auth.mfa_amr_claims",
  "auth.one_time_tokens", "auth.flow_state", "auth.audit_log_entries", "auth.sso_providers", "auth.sso_domains",
  "auth.saml_providers", "auth.saml_relay_states", "public.integration_secrets",
];
/** Blanked in auth.users: password hashes and every pending email/phone/recovery token. */
export const SCRUBBED_USER_COLUMNS = [
  "encrypted_password", "confirmation_token", "recovery_token", "email_change_token_new", "email_change_token_current",
  "phone_change_token", "reauthentication_token",
];
const AUTH_TABLES = ["auth.users", "auth.identities"];
const STORAGE_BUCKET = "workspace-assets";

export type TableDump = { table: string; columns: string[]; rows: Record<string, unknown>[] };
export type Manifest = {
  createdAt: string;
  tables: { table: string; rows: number; sha256: string }[];
  sequences: { sequence: string; lastValue: string | null }[];
  storageObjects: { name: string; bytes: number; file: string }[];
  excluded: string[];
  scrubbedUserColumns: string[];
  migrations: string[];
};

const quote = (qualified: string) => qualified.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".");

async function exportedTables(db: pg.Client): Promise<string[]> {
  const res = await db.query<{ t: string }>(
    `select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and n.nspname in ('public', 'private') order by 1`);
  const ownTables = res.rows.map((r) => r.t).filter((t) => !EXCLUDED_TABLES.includes(t));
  const storage = await db.query<{ t: string }>(
    `select 'storage.' || relname t from pg_class where relnamespace = 'storage'::regnamespace and relname in ('objects', 'prefixes') and relkind = 'r'`);
  return [...AUTH_TABLES, ...ownTables, ...storage.rows.map((r) => r.t)];
}

async function columnsOf(db: pg.Client, table: string): Promise<string[]> {
  const res = await db.query<{ attname: string }>(
    `select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped and attgenerated = '' order by attnum`,
    [quote(table)]);
  return res.rows.map((r) => r.attname);
}

/** Rows as the export (and the restore check) sees them: scrubbed, in a stable order. */
export async function readTable(db: pg.Client, table: string): Promise<TableDump> {
  const columns = await columnsOf(db, table);
  const where = table.startsWith("storage.") ? ` where bucket_id = '${STORAGE_BUCKET}'` : "";
  const list = columns.map((c) => `"${c}"`).join(", ");
  const res = await db.query<{ rows: Record<string, unknown>[] | null }>(
    `select json_agg(to_jsonb(t) order by to_jsonb(t)::text) rows from (select ${list} from ${quote(table)}${where}) t`);
  const rows = res.rows[0].rows ?? [];
  if (table === "auth.users") {
    for (const row of rows) for (const c of SCRUBBED_USER_COLUMNS) if (c in row) row[c] = c === "encrypted_password" ? null : "";
  }
  return { table, columns, rows };
}

export const digest = (dump: TableDump) => createHash("sha256").update(JSON.stringify(dump.rows)).digest("hex");

/** Writes `dir/manifest.json`, one JSON file per table, and Storage object files under `dir/storage`. */
export async function exportStack(source: Stack, db: pg.Client, dir: string): Promise<Manifest> {
  mkdirSync(join(dir, "tables"), { recursive: true });
  const manifest: Manifest = {
    createdAt: new Date().toISOString(), tables: [], sequences: [], storageObjects: [],
    excluded: EXCLUDED_TABLES, scrubbedUserColumns: SCRUBBED_USER_COLUMNS, migrations: [],
  };
  for (const table of await exportedTables(db)) {
    const dump = await readTable(db, table);
    writeFileSync(join(dir, "tables", `${table}.json`), JSON.stringify(dump));
    manifest.tables.push({ table, rows: dump.rows.length, sha256: digest(dump) });
  }
  const seqs = await db.query<{ s: string; v: string | null }>(
    `select schemaname || '.' || sequencename s, last_value::text v from pg_sequences where schemaname in ('public', 'private') order by 1`);
  manifest.sequences = seqs.rows.map((r) => ({ sequence: r.s, lastValue: r.v }));
  manifest.migrations = (await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by 1")).rows.map((r) => r.version);

  const objects = await db.query<{ name: string; version: string | null }>(
    "select name, version from storage.objects where bucket_id = $1 order by name", [STORAGE_BUCKET]);
  if (objects.rowCount) {
    const files = stackDocker(source, "storage", (c) => ["exec", c, "sh", "-c", "find /mnt /var/lib/storage -type f 2>/dev/null || true"])
      .split(/\r?\n/).filter(Boolean);
    for (const o of objects.rows) {
      const inside = files.find((f) => f.includes(`/${STORAGE_BUCKET}/${o.name}/`) && (!o.version || f.endsWith(`/${o.version}`)))
        ?? files.find((f) => f.includes(`/${STORAGE_BUCKET}/${o.name}`));
      if (!inside) throw new Error(`Storage file for ${o.name} was not found in the storage container`);
      const local = join(dir, "storage", ...inside.split("/").filter(Boolean));
      mkdirSync(dirname(local), { recursive: true });
      stackDocker(source, "storage", (c) => ["cp", `${c}:${inside}`, local]);
      manifest.storageObjects.push({ name: o.name, bytes: readFileSync(local).length, file: inside });
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Restores an export into a different, freshly migrated stack. Rows that the migrations already
 * created (reference data) are kept when identical (`on conflict do nothing`); the caller compares
 * digests afterwards. Runs in one transaction as the stack's superuser with triggers suspended.
 */
export async function restoreStack(target: Stack, dir: string): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const tag = `$fna_${createHash("sha256").update(dir).digest("hex").slice(0, 8)}$`;
  const parts = ["\\set ON_ERROR_STOP on", "begin;", "set local session_replication_role = replica;"];
  for (const { table } of manifest.tables) {
    const dump = JSON.parse(readFileSync(join(dir, "tables", `${table}.json`), "utf8")) as TableDump;
    if (!dump.rows.length) continue;
    const payload = JSON.stringify(dump.rows);
    if (payload.includes(tag)) throw new Error(`export for ${table} contains the quoting tag`);
    const cols = dump.columns.map((c) => `"${c}"`).join(", ");
    parts.push(
      `insert into ${quote(table)} (${cols}) overriding system value select ${cols} from json_populate_recordset(null::${quote(table)}, ${tag}${payload}${tag}::json) on conflict do nothing;`);
  }
  for (const s of manifest.sequences) {
    if (s.lastValue !== null) parts.push(`select setval('${quote(s.sequence)}', ${Number(s.lastValue)}, true);`);
  }
  parts.push("commit;");
  stackDocker(target, "db", (c) => ["exec", "-i", c, "psql", "-q", "-U", "supabase_admin", "-d", "postgres", "-f", "-"], parts.join("\n"), 600_000);

  for (const o of manifest.storageObjects) {
    const local = join(dir, "storage", ...o.file.split("/").filter(Boolean));
    const folder = o.file.slice(0, o.file.lastIndexOf("/"));
    stackDocker(target, "storage", (c) => ["exec", "-u", "0", c, "mkdir", "-p", folder]);
    stackDocker(target, "storage", (c) => ["cp", local, `${c}:${o.file}`]);
  }
}

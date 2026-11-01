import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { freshDb, migrationFiles } from "./harness";

const TENANT_TABLES = [
  "workspace_members", "member_permission_overrides", "user_active_workspace", "workspace_invitations",
  "platform_access_grants", "workspace_settings", "ai_receptionist_configs", "integrations",
  "integration_secrets", "contacts", "contact_tags", "contact_notes", "pipelines", "pipeline_stages",
  "opportunities", "calendars", "calendar_members", "availability_rules", "appointments",
  "conversations", "messages", "tasks", "reviews", "activity_events", "workspace_audit_log",
];
const GLOBAL_TABLES = [
  "profiles", "platform_admins", "workspaces", "role_permissions", "grant_mode_permissions", "platform_audit_log",
];
const LEGACY_TABLES = [
  "auth_sessions", "sync_contacts", "sync_contact_tags", "sync_opportunities", "sync_appointments",
  "sync_conversation_events", "sync_tasks", "sync_review_events", "sync_events", "sync_idempotency",
];

describe("migrations apply to a clean local database", () => {
  test("every migration has a unique 14-digit Supabase CLI version", () => {
    const files = migrationFiles();
    const versions = files.map((f) => {
      const m = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(f);
      assert.ok(m, `${f} must be named <14-digit version>_<name>.sql`);
      return m[1];
    });
    assert.equal(new Set(versions).size, versions.length, "duplicate migration versions");
    assert.deepEqual([...versions].sort(), versions, "filename order must match version order");
    assert.deepEqual(files.slice(0, 2), ["20260917121316_sync_store.sql", "20260917185155_auth_sessions.sql"]);
  });

  test("the staging/production manifest in the cutover checklist lists exactly the repository migrations, never M15", () => {
    const checklist = readFileSync(join(__dirname, "..", "..", "docs", "STAGING_CUTOVER_CHECKLIST.md"), "utf8");
    const section = checklist.split(/^## 5\. Required migration manifest/m)[1]?.split(/^## /m)[0] ?? "";
    const listed = [...section.matchAll(/^\| (legacy|M\d+) \| `(\d{14}_[a-z0-9_]+\.sql)` \|/gm)];
    assert.deepEqual(listed.map((m) => m[2]), migrationFiles(), "manifest must equal supabase/migrations in order");
    assert.ok(!listed.some((m) => m[1] === "M15"), "M15 is never part of the deployable manifest");
    assert.match(section, /Excluded: M15/);
  });

  test("all migrations apply in order", async () => {
    const files = migrationFiles();
    assert.ok(files.length >= 15, `expected legacy + 13 new migrations, found ${files.length}`);
    const db = await freshDb();
    await db.close();
  });

  test("legacy tables are preserved and new tables exist", async () => {
    const db = await freshDb();
    const res = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
    );
    const names = new Set(res.rows.map((r) => r.table_name));
    for (const t of [...TENANT_TABLES, ...GLOBAL_TABLES, ...LEGACY_TABLES]) {
      assert.ok(names.has(t), `missing table ${t}`);
    }
    await db.close();
  });

  test("every new public table has RLS enabled and forced", async () => {
    const db = await freshDb();
    const res = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1)`,
      [[...TENANT_TABLES, ...GLOBAL_TABLES]]
    );
    assert.equal(res.rows.length, TENANT_TABLES.length + GLOBAL_TABLES.length);
    for (const r of res.rows) {
      assert.ok(r.relrowsecurity, `${r.relname} RLS not enabled`);
      assert.ok(r.relforcerowsecurity, `${r.relname} RLS not forced`);
    }
    await db.close();
  });

  test("every tenant table except the active-workspace pointer requires workspace_id", async () => {
    const db = await freshDb();
    const res = await db.query<{ table_name: string; is_nullable: string }>(
      `select table_name, is_nullable from information_schema.columns
       where table_schema = 'public' and column_name = 'workspace_id' and table_name = any($1)`,
      [TENANT_TABLES]
    );
    assert.equal(res.rows.length, TENANT_TABLES.length);
    for (const r of res.rows) assert.equal(r.is_nullable, "NO", `${r.table_name}.workspace_id is nullable`);
    await db.close();
  });

  test("anon holds no privileges on any new table", async () => {
    const db = await freshDb();
    const res = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'anon' and table_schema = 'public' and table_name = any($1)`,
      [[...TENANT_TABLES, ...GLOBAL_TABLES]]
    );
    assert.deepEqual(res.rows, []);
    await db.close();
  });

  test("anon can execute only peek_invitation and the PostgREST pre-request check among new public functions", async () => {
    const db = await freshDb();
    const res = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
         and p.proname not like 'pg\\_%'`
    );
    // PostgREST runs the pre-request check as the request's role, anon included; it returns nothing.
    assert.deepEqual(res.rows.map((r) => r.proname).sort(), ["check_request_session", "peek_invitation"]);
    await db.close();
  });

  test("the rollback script removes only native objects, and migrations re-apply cleanly afterwards", async () => {
    const db = await freshDb();
    const legacyBefore = await db.query<{ n: number }>("select count(*)::int n from public.auth_sessions");
    await db.exec(readFileSync(join(__dirname, "..", "..", "supabase", "rollback", "20261101_native_multi_tenant.down.sql"), "utf8"));

    const left = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1");
    assert.deepEqual(left.rows.map((r) => r.table_name).sort(), [...LEGACY_TABLES].sort());
    const legacyAfter = await db.query<{ n: number }>("select count(*)::int n from public.auth_sessions");
    assert.equal(legacyAfter.rows[0].n, legacyBefore.rows[0].n);

    for (const file of migrationFiles().filter((f) => f.startsWith("20261101"))) {
      await db.exec(readFileSync(join(__dirname, "..", "..", "supabase", "migrations", file), "utf8"));
    }
    const back = await db.query<{ n: number }>(
      "select count(*)::int n from information_schema.tables where table_schema = 'public' and table_name = any($1)",
      [[...TENANT_TABLES, ...GLOBAL_TABLES]]);
    assert.equal(back.rows[0].n, TENANT_TABLES.length + GLOBAL_TABLES.length);
    await db.close();
  });

  test("no private helper is executable by anon or PUBLIC", async () => {
    const db = await freshDb();
    const res = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and has_function_privilege('anon', p.oid, 'execute')`
    );
    assert.deepEqual(res.rows, []);
    await db.close();
  });
});

// P7 (spec §8.3, §21): the GHL runtime is retired. GHL-1 and GHL-2 run over the real tree. The only
// remaining matches are the two legacy snapshot files kept for AUTH_PROVIDER=legacy until T6/M15; they
// are listed exactly, so any new reference — or the removal of the last ones — fails here.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(__dirname, "..");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

const GHL_1_SCOPE = () => [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "scripts")),
  ...walk(join(ROOT, "public")),
  ...readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.startsWith("2026110")).map((f) => join(ROOT, "supabase", "migrations", f)),
];
const TEXT = /\.(ts|tsx|mjs|cjs|js|css|sql|json|html|txt|md)$/;

/** Legacy snapshot reader kept for AUTH_PROVIDER=legacy until T6 (spec §21.3). */
const LEGACY_REMAINING = ["src/lib/legacy/deployment.ts", "src/lib/legacy/snapshot.ts"];

const RETIRED = [
  "src/lib/ghl.ts", "src/lib/mapping.ts", "src/lib/owner-values.ts", "src/lib/master-guard.ts", "src/lib/leads.ts", "src/lib/env.ts",
  "src/lib/sync", "src/lib/deployment", "src/lib/onboarding", "src/lib/tenant.ts", "src/lib/tenant-ui.ts", "src/lib/auth/legacy-only.ts",
  "src/app/api/ghl", "src/app/api/webhooks", "src/app/api/leads", "src/app/api/sync", "src/app/api/events",
  "src/app/api/onboarding/readiness", "public/ghl-custom.css",
  "scripts/check-client-readiness.ts", "scripts/client-prepare.ts", "scripts/generate-client-deployment.ts", "scripts/validate-client-env.ts",
  "config", "docs/GHL_SYNC_WEBHOOK_CONTRACT.md", "docs/GHL_WORKFLOW_SYNC_MAP.md", "docs/WEBHOOK_SECURITY_V1.md",
];

describe("P7: GHL runtime retired", () => {
  test("GHL-1: ghl|highlevel|leadconnector|location_id matches only the listed legacy snapshot files", () => {
    const hits = GHL_1_SCOPE()
      .filter((f) => TEXT.test(f) && /ghl|highlevel|leadconnector|location_id/i.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    assert.deepEqual(hits, LEGACY_REMAINING);
  });

  test("GHL-2: no code reads GHL_* or the retired settings, except the legacy snapshot partition", () => {
    const readers: string[] = [];
    for (const f of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))].filter((p) => TEXT.test(p))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b(GHL_[A-Z_]+|FAKE_CONTACT_ONLY|ALLOW_PRODUCTION_CONTACT_WRITES|FORBIDDEN_MASTER_LOCATION_ID|CLIENT_CONFIG_PATH)\b/g)) {
        readers.push(`${rel(f)}:${m[1]}`);
      }
    }
    assert.deepEqual([...new Set(readers)].sort(), ["src/lib/legacy/deployment.ts:GHL_LOCATION_ID"]);
  });

  test("the retired modules, routes, scripts, configuration, and public stylesheet are gone", () => {
    assert.deepEqual(RETIRED.filter((p) => existsSync(join(ROOT, p))), []);
  });

  test("the GHL documents are archived, not lost", () => {
    const docs = ["GHL_SYNC_WEBHOOK_CONTRACT.md", "GHL_WORKFLOW_SYNC_MAP.md", "WEBHOOK_SECURITY_V1.md",
      "CLIENT_DEPLOYMENT_RUNBOOK.md", "CLIENT_CLONE_MANIFEST.md", "CLIENT_GO_LIVE_GATE.md", "CLIENT_ONBOARDING_CHECKLIST.md",
      "FAST_CLIENT_ONBOARDING.md", "FIRST_FAKE_CLIENT_E2E.md", "TENANT_CONTENT_AUDIT.md", "297_FEATURE_MATRIX.md"];
    const checklists = ["SNAPSHOT_CLONE_SYSTEM.md", "POST_CLONE_VALIDATOR.md", "WEBSITE_GHL_INTEGRATION.md"];
    for (const f of [...docs, ...checklists.map((c) => `checklists/${c}`), "README.md"]) {
      assert.ok(existsSync(join(ROOT, "docs", "archive", f)), f);
    }
    for (const f of docs) assert.equal(existsSync(join(ROOT, "docs", f)), false, `docs/${f} moved`);
    for (const c of checklists) assert.equal(existsSync(join(ROOT, "checklists", c)), false, `checklists/${c} moved`);
    assert.match(read("docs/archive/README.md"), /git revert/);
  });

  test("only legacy entry points load the legacy modules, and native code paths import them lazily", () => {
    const STATIC = /^import[^;]*from\s+["'](@\/lib\/legacy\/[^"']+|\.\/legacy|\.\.?\/(?:\.\.\/)*legacy\/[^"']+)["']/m;
    const allowed = new Set([
      "src/lib/data/legacy.ts",
      "src/lib/auth/session-store.ts",
      "src/lib/auth/session-edge.ts",
      ...walk(join(ROOT, "src", "lib", "legacy")).map(rel),
    ]);
    const offenders = walk(join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && STATIC.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !allowed.has(f));
    assert.deepEqual(offenders, []);
    for (const f of ["src/lib/data/index.ts", "src/lib/data/api.ts", "src/app/api/health/route.ts",
      "src/app/api/tenant/config/route.ts", "src/app/api/tenant/public/route.ts"]) {
      assert.match(read(f), /await import\("(@\/lib\/legacy\/[a-z-]+|\.\/legacy)"\)/, f);
    }
  });

  test("the legacy session code uses only the URL check and REST auth headers from the legacy area", () => {
    for (const f of ["src/lib/auth/session-store.ts", "src/lib/auth/session-edge.ts"]) {
      const imports = [...read(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/legacy\/([a-z-]+)["']/g)]
        .map((m) => `${m[2]}:${m[1].split(",").map((s) => s.trim()).filter(Boolean).sort().join(",")}`);
      for (const i of imports) {
        assert.ok(/^rest-auth:supabaseRestAuthHeaders$|^rest-client:(isSupabaseConfigured,)?isValidSupabaseUrl$/.test(i), `${f} ${i}`);
      }
    }
  });

  test("middleware, .env.example, and package scripts carry no retired paths or settings", () => {
    const middleware = read("src/middleware.ts");
    for (const p of ["/api/webhooks", "/api/leads", "/api/events", "/api/sync/health", "/api/onboarding/readiness", "/api/ghl"]) {
      assert.equal(middleware.includes(`"${p}`), false, p);
    }
    const envExample = read(".env.example");
    assert.equal(/GHL_|FAKE_CONTACT_ONLY|ALLOW_PRODUCTION_CONTACT_WRITES|FORBIDDEN_MASTER_LOCATION_ID|CLIENT_CONFIG_PATH|owner-values/.test(envExample), false);
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      for (const m of cmd.matchAll(/(scripts\/[A-Za-z0-9._-]+)/g)) assert.ok(existsSync(join(ROOT, m[1])), `${name} -> ${m[1]}`);
    }
  });

  test("the real-stack harness starts the app with every GHL_* variable removed", () => {
    assert.match(read("tests/supabase-stack/stack.ts"), /if \(\/\^\(AUTH_\|SUPABASE_\|GHL_\|VERCEL\)\/\.test\(k\)\) continue;/);
  });
});

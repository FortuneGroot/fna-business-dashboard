#!/usr/bin/env node
/**
 * Non-skippable release security gate.
 *
 * 1) Runs a clean production build
 * 2) Requires .next/static to exist
 * 3) Scans client assets for protected operational IDs and secret VALUE shapes
 * 4) Prints only filenames + categories (never secret values)
 *
 * Usage: node scripts/release-security-gate.mjs
 * Exit 0 = pass; non-zero = fail
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const STATIC = join(ROOT, ".next", "static");

const RETIRED_PIPELINE = "iYIxeKOdg5jkoAfKNnYM";

function walk(dir, out = [], ext = /\.(js|css|html|map)$/) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, ext);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

function fail(msg) {
  console.error("RELEASE_SECURITY_FAIL:", msg);
  process.exit(1);
}

console.log("RELEASE_SECURITY_GATE: clean build…");
if (existsSync(join(ROOT, ".next"))) {
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
}
const build = spawnSync(
  process.execPath,
  [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "build"],
  { cwd: ROOT, stdio: "inherit", env: process.env }
);
if (build.status !== 0) fail("production build failed");

if (!existsSync(STATIC)) fail(".next/static missing after build");

// Load IDs from master-guard via tsx without printing them
const stub = join(ROOT, "scripts", "stub-server-only.cjs");
const require = createRequire(import.meta.url);
// Dynamic import through a tiny child process to use tsx + stub
const idProbe = spawnSync(
  process.execPath,
  [
    "--require",
    stub,
    "--import",
    "tsx",
    "-e",
    `
    import { PROTECTED_MASTER_LOCATION_ID, FA_LIVE_LOCATION_ID, FA_LIVE_PIPELINE_ID } from "./src/lib/master-guard.ts";
    process.stdout.write(JSON.stringify({
      master: PROTECTED_MASTER_LOCATION_ID,
      live: FA_LIVE_LOCATION_ID,
      pipe: FA_LIVE_PIPELINE_ID,
    }));
    `,
  ],
  { cwd: ROOT, encoding: "utf8" }
);
if (idProbe.status !== 0) {
  console.error(idProbe.stderr);
  fail("could not load master-guard IDs for scan");
}
const ids = JSON.parse(idProbe.stdout);

const patterns = [
  { cat: "master_location_id", lit: ids.master },
  { cat: "live_location_id", lit: ids.live },
  { cat: "active_pipeline_id", lit: ids.pipe },
  { cat: "retired_pipeline_id", lit: RETIRED_PIPELINE },
  { cat: "sb_secret_value", re: /sb_secret_[A-Za-z0-9_]{8,}/ },
  {
    cat: "jwt_service_role_value",
    re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    cat: "privileged_next_public",
    re: /NEXT_PUBLIC_(SUPABASE_SERVICE_ROLE|AUTH_SECRET|GHL_WEBHOOK|AUTH_OWNER_PASSWORD|GHL_API_TOKEN)/,
  },
];

const files = walk(STATIC);
if (files.length < 5) fail(`too few static assets (${files.length})`);

const hits = {};
for (const p of patterns) hits[p.cat] = [];

for (const file of files) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const p of patterns) {
    const found = p.lit ? text.includes(p.lit) : p.re.test(text);
    if (found) hits[p.cat].push(relative(ROOT, file));
  }
}

const any = Object.values(hits).some((v) => v.length);
console.log(
  JSON.stringify(
    {
      staticFileCount: files.length,
      hitCounts: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length])),
      hitFilesByCategory: Object.fromEntries(
        Object.entries(hits)
          .filter(([, v]) => v.length)
          .map(([k, v]) => [k, v.slice(0, 20)])
      ),
    },
    null,
    2
  )
);

if (any) fail("prohibited categories found in client assets (filenames above)");

// Confirm stub is test-only: production build must still fail client import of server-only
const masterGuard = readFileSync(join(ROOT, "src", "lib", "master-guard.ts"), "utf8");
if (!/import\s+["']server-only["']/.test(masterGuard)) {
  fail("master-guard.ts missing server-only import");
}

console.log("RELEASE_SECURITY_PASS");
process.exit(0);

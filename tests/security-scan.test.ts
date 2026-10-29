import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { PROTECTED_MASTER_LOCATION_ID } from "../src/lib/master-guard";

/**
 * Browser-bundle + source boundary scans.
 * Server bundles may reference env KEY names — that is not a leak.
 * Fail on embedded secret VALUE shapes and the protected Master location id.
 */

const MASTER_ID = PROTECTED_MASTER_LOCATION_ID;

const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "sb_secret_value", re: /sb_secret_[A-Za-z0-9_]{8,}/ },
  {
    name: "jwt_service_role_value",
    re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

const CLIENT_ENTRY_GLOBS = [
  join(process.cwd(), "src", "components"),
  join(process.cwd(), "src", "app", "login"),
  join(process.cwd(), "src", "lib", "ui"),
];

function walk(dir: string, out: string[] = [], ext = /\.(js|css|html)$/): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, ext);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  return walk(dir, out, /\.(tsx|ts)$/);
}

describe("compiled client bundle secret scan", () => {
  it("browser static chunks do not embed secret values", () => {
    const staticRoot = join(process.cwd(), ".next", "static");
    if (!existsSync(staticRoot)) {
      assert.ok(true, "no .next/static — skip until production build");
      return;
    }
    const hits: string[] = [];
    for (const file of walk(staticRoot)) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const { name, re } of VALUE_PATTERNS) {
        if (re.test(text)) hits.push(`${file} :: ${name}`);
      }
    }
    assert.deepEqual(hits, [], hits.slice(0, 25).join("\n"));
  });

  it("browser static chunks contain zero protected Master location ids", () => {
    const staticRoot = join(process.cwd(), ".next", "static");
    if (!existsSync(staticRoot)) {
      assert.ok(
        true,
        "no .next/static yet — Master-id chunk scan runs after production build"
      );
      return;
    }
    const hits: string[] = [];
    for (const file of walk(staticRoot)) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes(MASTER_ID)) {
        hits.push(relative(process.cwd(), file));
      }
    }
    assert.deepEqual(hits, [], `Master id in client chunks:\n${hits.join("\n")}`);
  });

  it("public/ static assets contain zero protected Master location ids", () => {
    const publicRoot = join(process.cwd(), "public");
    const hits: string[] = [];
    for (const file of walk(publicRoot, [], /\.(css|js|html|json|txt|md)$/)) {
      const text = readFileSync(file, "utf8");
      if (text.includes(MASTER_ID)) hits.push(relative(process.cwd(), file));
    }
    assert.deepEqual(hits, [], hits.join("\n"));
  });

  it("protected UI pages do not render the Master location id as copy", () => {
    const root = join(process.cwd(), "src", "app", "(protected)");
    for (const file of walkTs(root)) {
      const text = readFileSync(file, "utf8");
      const withoutImports = text.replace(/^import .+$/gm, "");
      assert.equal(
        withoutImports.includes(MASTER_ID),
        false,
        `Master id in protected page copy: ${file}`
      );
    }
  });

  it("client-safe brand module has no Master / live location / pipeline UUIDs", () => {
    const brand = readFileSync(join(process.cwd(), "src", "lib", "brand.ts"), "utf8");
    assert.equal(brand.includes(MASTER_ID), false, "brand.ts must not embed Master id");
    assert.equal(
      /kIXDnRuhkj6HLR1g6V6V|6XevPh4T3rX0qAYRfuta/.test(brand),
      false,
      "brand.ts must not embed live location/pipeline ids"
    );
    assert.equal(/forbiddenMasterId|liveLocationId|pipelineId\s*:/.test(brand), false);
  });

  it("client components and sync-copy never import master-guard or privileged tenant ids", () => {
    const offenders: string[] = [];
    const roots = [
      ...CLIENT_ENTRY_GLOBS,
      join(process.cwd(), "src", "app", "privacy"),
      join(process.cwd(), "src", "app", "terms"),
    ];
    for (const root of roots) {
      for (const file of walkTs(root)) {
        const text = readFileSync(file, "utf8");
        if (/from\s+["']@\/lib\/master-guard["']/.test(text)) {
          offenders.push(`${relative(process.cwd(), file)} :: master-guard`);
        }
        if (text.includes(MASTER_ID)) {
          offenders.push(`${relative(process.cwd(), file)} :: Master id literal`);
        }
      }
    }
    // Client components that import brand must only pull client-safe brand.ts
    for (const file of walkTs(join(process.cwd(), "src", "components"))) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["']@\/lib\/(tenant|mapping|env|ghl|master-guard)["']/.test(text)) {
        offenders.push(`${relative(process.cwd(), file)} :: privileged server import`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("src never declares NEXT_PUBLIC privileged credentials", () => {
    const src = join(process.cwd(), "src");
    for (const file of walkTs(src)) {
      const text = readFileSync(file, "utf8");
      assert.equal(
        /NEXT_PUBLIC_(SUPABASE_SERVICE_ROLE|AUTH_SECRET|GHL_WEBHOOK|AUTH_OWNER_PASSWORD|GHL_API_TOKEN)/.test(
          text
        ),
        false,
        file
      );
    }
  });

  it("master-guard is marked server-only", () => {
    const text = readFileSync(join(process.cwd(), "src", "lib", "master-guard.ts"), "utf8");
    assert.match(text, /import\s+["']server-only["']/);
    assert.match(text, new RegExp(MASTER_ID));
  });
});

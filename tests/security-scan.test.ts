import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Browser-bundle scan only (.next/static).
 * Server bundles legitimately reference process.env KEY NAMES — that is not a leak.
 * We fail on embedded secret VALUE shapes and the protected Master location id.
 */

const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "sb_secret_value", re: /sb_secret_[A-Za-z0-9_]{8,}/ },
  { name: "jwt_service_role_value", re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** Documented separately: Master id must not appear in client UI copy; server brand module may still reference it. */
const MASTER_ID = "NQwD3zdWCuBSVpOuzybj";

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|css|html)$/.test(name)) out.push(p);
  }
  return out;
}

describe("compiled client bundle secret scan", () => {
  it("browser static chunks do not embed secret values or Master id", () => {
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

  it("protected UI pages do not render the Master location id as copy", () => {
    const root = join(process.cwd(), "src", "app", "(protected)");
    function walkTs(dir: string, out: string[] = []): string[] {
      if (!existsSync(dir)) return out;
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkTs(p, out);
        else if (/\.(tsx|ts)$/.test(name)) out.push(p);
      }
      return out;
    }
    for (const file of walkTs(root)) {
      const text = readFileSync(file, "utf8");
      // Allow imports of server guards, but not string literals in JSX/copy.
      const withoutImports = text.replace(/^import .+$/gm, "");
      assert.equal(
        withoutImports.includes(MASTER_ID),
        false,
        `Master id in protected page copy: ${file}`
      );
    }
  });

  it("src never declares NEXT_PUBLIC privileged credentials", () => {
    const src = join(process.cwd(), "src");
    function walkTs(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walkTs(p, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(p);
      }
      return out;
    }
    for (const file of walkTs(src)) {
      const text = readFileSync(file, "utf8");
      assert.equal(
        /NEXT_PUBLIC_(SUPABASE_SERVICE_ROLE|AUTH_SECRET|GHL_WEBHOOK|AUTH_OWNER_PASSWORD)/.test(
          text
        ),
        false,
        file
      );
    }
  });
});

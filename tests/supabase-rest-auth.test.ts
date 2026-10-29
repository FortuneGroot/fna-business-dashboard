import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isLegacyJwtServiceRoleKey,
  isSbSecretServiceRoleKey,
  supabaseRestAuthHeaders,
} from "../src/lib/sync/supabase-rest-auth";

describe("supabase REST auth headers", () => {
  it("sb_secret_ keys use apikey only (never Authorization Bearer)", () => {
    const key = "sb_secret_test_placeholder_not_real";
    assert.equal(isSbSecretServiceRoleKey(key), true);
    assert.equal(isLegacyJwtServiceRoleKey(key), false);
    const h = supabaseRestAuthHeaders(key);
    assert.equal(h.apikey, key);
    assert.equal(Object.prototype.hasOwnProperty.call(h, "Authorization"), false);
    assert.equal(h.Authorization, undefined);
  });

  it("legacy eyJ service_role JWTs keep apikey + Authorization Bearer", () => {
    // Synthetic JWT-shaped placeholder — not a real credential.
    const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature";
    assert.equal(isLegacyJwtServiceRoleKey(key), true);
    assert.equal(isSbSecretServiceRoleKey(key), false);
    const h = supabaseRestAuthHeaders(key);
    assert.equal(h.apikey, key);
    assert.equal(h.Authorization, `Bearer ${key}`);
  });

  it("trims whitespace and still classifies correctly", () => {
    const sb = supabaseRestAuthHeaders("  sb_secret_trimmed  ");
    assert.equal(sb.apikey, "sb_secret_trimmed");
    assert.equal(sb.Authorization, undefined);

    const jwt = supabaseRestAuthHeaders("  eyJabc.def.ghi  ");
    assert.equal(jwt.apikey, "eyJabc.def.ghi");
    assert.equal(jwt.Authorization, "Bearer eyJabc.def.ghi");
  });

  it("source call sites do not hardcode Bearer with service role key", () => {
    const roots = [
      join(process.cwd(), "src", "lib", "auth"),
      join(process.cwd(), "src", "lib", "sync"),
    ];
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !name.includes("supabase-rest-auth")) {
          const text = readFileSync(p, "utf8");
          // Forbidden: pairing apikey with Authorization Bearer using the same key variable.
          if (
            /apikey:\s*(?:cfg\.)?key/.test(text) &&
            /Authorization:\s*`Bearer \$\{(?:cfg\.)?key\}`/.test(text)
          ) {
            offenders.push(p);
          }
        }
      }
    }
    for (const r of roots) walk(r);
    assert.deepEqual(offenders, [], `hardcoded dual headers remain in:\n${offenders.join("\n")}`);
  });
});

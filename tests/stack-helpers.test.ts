import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import {
  assertDisposable, createDisposableProject, DISPOSABLE_MARKER, DISPOSABLE_PREFIX, jwtPayload, PORT_OFFSET, signJwt, totp,
  type DisposableProject, type StackEnv,
} from "./supabase-stack/stack";

const ROOT = join(__dirname, "..");

test("TOTP matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32("12345678901234567890")
  const vectors: [number, string][] = [
    [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
    [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
  ];
  for (const [t, code] of vectors) assert.equal(totp(secret, t * 1000), code, `T=${t}`);
});

test("signJwt produces a verifiable HS256 token", () => {
  const token = signJwt("local-secret", { sub: "u1", exp: 1 });
  const [h, p, s] = token.split(".");
  assert.equal(createHmac("sha256", "local-secret").update(`${h}.${p}`).digest("base64url"), s);
  assert.deepEqual(jwtPayload(token), { sub: "u1", exp: 1 });
});

describe("the stack suite only resets an isolated, explicitly disposable Supabase project", () => {
  const envFor = (p: DisposableProject, host = "127.0.0.1"): StackEnv => ({
    apiUrl: `http://${host}:${p.apiPort}`,
    dbUrl: `postgresql://postgres:postgres@${host}:${p.dbPort}/postgres`,
    anonKey: "a", serviceRoleKey: "s", jwtSecret: "j",
  });

  function withProject(fn: (p: DisposableProject) => void) {
    const p = createDisposableProject();
    try {
      fn(p);
    } finally {
      rmSync(p.workdir, { recursive: true, force: true });
    }
  }

  test("the disposable copy has a random project id, shifted ports, a marker, and only migrations + config", () => {
    withProject((p) => {
      assert.ok(p.projectId.startsWith(DISPOSABLE_PREFIX));
      assert.ok(!relative(tmpdir(), p.workdir).startsWith(".."));
      const devConfig = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
      const devApi = Number(/\[api\][\s\S]*?\nport = (\d+)/.exec(devConfig)![1]);
      const devDb = Number(/\[db\][\s\S]*?\nport = (\d+)/.exec(devConfig)![1]);
      assert.equal(p.apiPort, devApi + PORT_OFFSET);
      assert.equal(p.dbPort, devDb + PORT_OFFSET);
      const cfg = readFileSync(join(p.workdir, "supabase", "config.toml"), "utf8");
      assert.match(cfg, new RegExp(`^project_id = "${p.projectId}"$`, "m"));
      assert.doesNotMatch(cfg, /^port = 5432\d$/m, "no developer-stack port may remain");
      assert.ok(existsSync(join(p.workdir, DISPOSABLE_MARKER)));
      assert.deepEqual(readdirSync(join(p.workdir, "supabase")).sort(), ["config.toml", "migrations"]);
      assert.deepEqual(
        readdirSync(join(p.workdir, "supabase", "migrations")),
        readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql"))
      );
      assert.doesNotThrow(() => assertDisposable(p, envFor(p), true));
    });
  });

  test("refuses a stack this run did not start", () => {
    withProject((p) => assert.throws(() => assertDisposable(p, envFor(p), false), /not started by this run/));
  });

  test("refuses the developer's stack ports and non-local hosts", () => {
    withProject((p) => {
      const dev = { ...envFor(p), apiUrl: `http://127.0.0.1:${p.apiPort - PORT_OFFSET}`, dbUrl: `postgresql://x@127.0.0.1:${p.dbPort - PORT_OFFSET}/postgres` };
      assert.throws(() => assertDisposable(p, dev, true), /API is not on the disposable local port.*database is not/);
      assert.throws(() => assertDisposable(p, envFor(p, "db.example.supabase.co"), true), /not on the disposable local port/);
      assert.throws(() => assertDisposable(p, null, true), /status is unavailable/);
    });
  });

  test("refuses when the marker is missing or does not match", () => {
    withProject((p) => {
      writeFileSync(join(p.workdir, DISPOSABLE_MARKER), JSON.stringify({ projectId: p.projectId, token: "other", disposable: true }));
      assert.throws(() => assertDisposable(p, envFor(p), true), /marker does not match/);
      rmSync(join(p.workdir, DISPOSABLE_MARKER));
      assert.throws(() => assertDisposable(p, envFor(p), true), /marker is missing/);
    });
  });

  test("refuses when the project id is the real project's or the workdir is linked", () => {
    withProject((p) => {
      const cfgPath = join(p.workdir, "supabase", "config.toml");
      writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/^project_id = .*$/m, 'project_id = "fna-business-dashboard"'));
      assert.throws(() => assertDisposable(p, envFor(p), true), /config project_id does not match/);
      assert.throws(() => assertDisposable({ ...p, projectId: "fna-business-dashboard" }, envFor(p), true), /project id is not disposable/);
    });
    withProject((p) => {
      mkdirSync(join(p.workdir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(p.workdir, "supabase", ".temp", "project-ref"), "abcdefghijklmnop");
      assert.throws(() => assertDisposable(p, envFor(p), true), /linked to a remote project/);
    });
  });

  test("startStack asserts disposability before reset, and every CLI call targets the disposable workdir", () => {
    const src = readFileSync(join(ROOT, "tests", "supabase-stack", "stack.ts"), "utf8");
    const body = src.slice(src.indexOf("export function startStack"));
    const reset = body.indexOf('"db", "reset"');
    assert.ok(reset > 0);
    assert.ok(body.lastIndexOf("assertDisposable(project", reset) > body.indexOf('["start"]'), "assertDisposable must run between start and reset");
    assert.match(src, /\[CLI, \.\.\.args, "--workdir", project\.workdir\]/);
    assert.equal((src.match(/run\(process\.execPath, \[CLI/g) ?? []).length, 1, "only the workdir-bound helper may invoke the CLI");
  });

  test("refuses a workdir outside the OS temp directory (e.g. the repository itself)", () => {
    withProject((p) => {
      assert.throws(() => assertDisposable({ ...p, workdir: ROOT }, envFor(p), true), /not inside the OS temp directory/);
    });
  });
});

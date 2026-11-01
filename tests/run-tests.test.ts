import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(__dirname, "..");
const RUNNER = join(ROOT, "scripts", "run-tests.mjs");

function run(fixture: string, min = 1) {
  const res = spawnSync(process.execPath, [
    RUNNER, "--files", `tests/fixtures/runner/${fixture}.fixture.ts`, "--name", fixture, "--min", String(min), "--timeout", "10000",
  ], { cwd: ROOT, encoding: "utf8" });
  const summaryLine = (res.stdout ?? "").split(/\r?\n/).find((l) => l.includes(` ${fixture} `) && /^(PASS|FAIL|BLOCKED)/.test(l)) ?? "";
  return { code: res.status, summaryLine };
}

describe("scripts/run-tests.mjs fails closed", () => {
  test("a clean suite passes", () => {
    const r = run("pass");
    assert.equal(r.code, 0);
    assert.match(r.summaryLine, /^PASS/);
  });

  test("a failing test fails the run", () => {
    const r = run("fail");
    assert.equal(r.code, 1);
    assert.match(r.summaryLine, /^FAIL .*1 failed/);
  });

  test("cancelled tests (failed hook, timeout) fail the run even though fail = 0", () => {
    const r = run("cancelled");
    assert.equal(r.code, 1);
    assert.match(r.summaryLine, /^FAIL .*fail 0.*cancelled/);
  });

  test("a suite that runs fewer tests than its minimum fails", () => {
    // node:test counts a file with no tests as one passing test, so per-suite minimums are the guard.
    assert.equal(run("empty", 2).code, 1);
    const r = run("pass", 5);
    assert.equal(r.code, 1);
    assert.match(r.summaryLine, /only 1 tests ran \(minimum 5\)/);
  });

  test("an environment blocker is reported as BLOCKED, never PASS", () => {
    const r = run("blocked");
    assert.equal(r.code, 2);
    assert.match(r.summaryLine, /^BLOCKED .*BLOCKED: required local service/);
  });

  test("a real test failure stays FAIL even when another part of the suite is BLOCKED", () => {
    const r = run("blocked-and-failed");
    assert.equal(r.code, 1);
    assert.match(r.summaryLine, /^FAIL .*testCodeFailure: a real assertion failure/);
  });

  test("a real hook failure stays FAIL even when every test is cancelled and one hook is BLOCKED", () => {
    const r = run("blocked-and-hook-failed");
    assert.equal(r.code, 1);
    assert.match(r.summaryLine, /^FAIL .*fail 0.*hookFailed: broken group/);
  });

  test("an assertion whose message mentions BLOCKED: is still a FAIL", () => {
    const r = run("assertion-mentions-blocked");
    assert.equal(r.code, 1);
    assert.match(r.summaryLine, /^FAIL/);
  });

  test("npm test runs the runner, which includes the unit, database, concurrency, and stack suites", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.match(pkg.scripts.test, /scripts\/run-tests\.mjs/);
    assert.doesNotMatch(pkg.scripts.test, /--suite/);
    const runner = readFileSync(RUNNER, "utf8");
    for (const suite of ["unit:", "db:", "realpg:", "stack:", "acceptance:"]) assert.ok(runner.includes(suite), `runner lacks ${suite}`);
    assert.match(runner, /tests\/db"\)/);
    assert.match(runner, /tests\/db-real"\)/);
    assert.match(runner, /tests\/supabase-stack"\)/);
  });
});

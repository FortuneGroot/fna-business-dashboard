#!/usr/bin/env node
// Runs every test suite and fails unless each one reports a clean TAP summary.
//
// node:test reports hook failures and timeouts as "cancelled" (not "fail"), and a test file that
// exits early silently drops its remaining tests. So a suite only passes when: the process exits 0,
// a summary is present, fail = 0, cancelled = 0, skipped = 0, todo = 0, and at least MIN tests ran.
// A suite that cannot run because the environment is missing something reports BLOCKED (never PASS),
// but only if every root-cause failure is such a blocker; any real failure makes it FAIL.
//
// Usage: node scripts/run-tests.mjs [--suite unit|db|realpg|stack|acceptance]... [--files a.ts,b.ts --min N --name X]
// Exit codes: 0 all passed, 1 any failure, 2 nothing failed but something was BLOCKED.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const list = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `${dir}/${f}`);

// Minimum test counts guard against suites silently shrinking. Raise them when tests are added.
const SUITES = {
  unit: {
    label: "unit tests",
    files: () => [
      "tests/legacy-snapshot.test.ts", "tests/auth.test.ts",
      "tests/client-facing-copy.test.ts", "tests/supabase-rest-auth.test.ts", "tests/authorization.test.ts",
      "tests/security-scan.test.ts", "tests/run-tests.test.ts", "tests/stack-helpers.test.ts",
      "tests/p2-auth.test.ts", "tests/p2-review-fixes.test.ts", "tests/p3-data.test.ts",
      "tests/p3-display.test.ts", "tests/p4-team-settings.test.ts", "tests/p5-crm.test.ts",
      "tests/p6-platform.test.ts", "tests/p7-retirement.test.ts", "tests/bootstrap-platform-admin.test.ts",
    ],
    timeoutMs: 60_000,
    // P7 deleted 78 tests of retired workflow-sync code (sync, onboarding readiness, deployment validation) and added 20; acceptance fixes added 1; the bootstrap CLI and override lists added 10; M22 CLI changes added 4.
    min: 257,
  },
  db: {
    label: "database tests (PGlite + Supabase shim)",
    files: () => list("tests/db"),
    timeoutMs: 60_000,
    min: 232,
  },
  realpg: {
    label: "database concurrency tests (real local PostgreSQL, independent sessions)",
    files: () => list("tests/db-real"),
    timeoutMs: 240_000,
    // M23 booking races added 3.
    min: 38,
  },
  stack: {
    label: "real local Supabase stack (CLI migrations, GoTrue JWTs, PostgREST, Storage)",
    files: () => list("tests/supabase-stack"),
    timeoutMs: 1_200_000,
    // The invitation-page settle and retry check added 1.
    min: 70,
    serial: true,
  },
  acceptance: {
    label: "local acceptance rehearsals (fresh disposable stacks: P1–P7 journeys, hardening, backup/restore, scale)",
    files: () => list("tests/acceptance"),
    timeoutMs: 1_800_000,
    min: 38,
    // Each file starts its own stack on the same ports, so files run one at a time.
    serial: true,
  },
};

function parseArgs(argv) {
  const out = { suites: [], files: null, min: 1, name: "custom", timeoutMs: 60_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") out.suites.push(argv[++i]);
    else if (a === "--files") out.files = argv[++i].split(",").filter(Boolean);
    else if (a === "--min") out.min = Number(argv[++i]);
    else if (a === "--name") out.name = argv[++i];
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

export function parseTapSummary(tap) {
  const summary = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    if (m) summary[key] = Number(m[1]);
  }
  return summary;
}

// Failure types that are consequences of another failure rather than causes of their own.
const DERIVED_FAILURES = new Set(["cancelledByParent", "subtestsFailed"]);

/** Root-cause failures from TAP: every `not ok` entry whose failureType is not derived. */
export function rootCauseFailures(tap) {
  const lines = tap.split(/\r?\n/);
  const causes = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
    if (!head) continue;
    const block = [];
    for (i += 1; i < lines.length && !/^\s*\.\.\.\s*$/.test(lines[i]); i++) block.push(lines[i]);
    const text = block.join("\n");
    const failureType = /failureType: '([^']+)'/.exec(text)?.[1] ?? "unknown";
    if (DERIVED_FAILURES.has(failureType)) continue;
    const blocked = /\berror: (?:'|\|-?\s*\n\s*)BLOCKED:/.test(text) && !/\bcode: 'ERR_ASSERTION'/.test(text);
    const reason = blocked ? /BLOCKED:[^'\n]*/.exec(text)?.[0] : null;
    causes.push({ name: head[1].trim(), failureType, blocked, reason });
  }
  return causes;
}

/**
 * PASS only for a clean summary. BLOCKED only when there is at least one root-cause failure and
 * every root cause is an environment blocker (error starting with "BLOCKED:", not an assertion).
 * A real failure anywhere makes the suite FAIL, whatever else the output contains.
 */
export function judge({ exitCode, summary, min, tap = "" }) {
  const problems = [];
  const keys = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
  const hasSummary = keys.every((k) => summary[k] !== undefined);
  if (!hasSummary) problems.push("no TAP summary (runner crashed?)");
  if ((summary.fail ?? 0) > 0) problems.push(`${summary.fail} failed`);
  if ((summary.cancelled ?? 0) > 0) problems.push(`${summary.cancelled} cancelled`);
  if ((summary.skipped ?? 0) > 0) problems.push(`${summary.skipped} skipped`);
  if ((summary.todo ?? 0) > 0) problems.push(`${summary.todo} todo`);
  if ((summary.tests ?? 0) < min) problems.push(`only ${summary.tests ?? 0} tests ran (minimum ${min})`);
  if (exitCode !== 0) problems.push(`exit code ${exitCode}`);
  if (problems.length === 0) return { status: "PASS", problems };

  const causes = rootCauseFailures(tap);
  const blocked = hasSummary && causes.length > 0 && causes.every((c) => c.blocked)
    && (summary.skipped ?? 0) === 0 && (summary.todo ?? 0) === 0;
  if (blocked) {
    const reasons = [...new Set(causes.map((c) => c.reason))];
    return { status: "BLOCKED", problems: [...reasons, ...problems] };
  }
  const real = causes.filter((c) => !c.blocked).map((c) => `${c.failureType}: ${c.name}`);
  return { status: "FAIL", problems: real.length ? [...problems, ...real.slice(0, 5)] : problems };
}

function runSuite(name, { label, files, timeoutMs, min, serial }) {
  const dir = mkdtempSync(join(tmpdir(), "fna-tests-"));
  const tapFile = join(dir, "results.tap");
  try {
    const args = [
      "--require", "./scripts/stub-server-only.cjs", "--import", "tsx", "--test",
      `--test-timeout=${timeoutMs}`,
      ...(serial ? ["--test-concurrency=1"] : []),
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=tap", `--test-reporter-destination=${tapFile}`,
      ...files,
    ];
    console.log(`\n=== ${name}: ${label} (${files.length} files) ===`);
    // NODE_TEST_CONTEXT (set when launched from inside node:test) would switch the child into
    // child-reporter mode and suppress the TAP summary.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    let tap = "";
    try {
      tap = readFileSync(tapFile, "utf8");
    } catch {
      tap = "";
    }
    const summary = parseTapSummary(tap);
    const verdict = judge({ exitCode: res.status ?? 1, summary, min, tap });
    return { name, label, summary, ...verdict };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = args.files
    ? [[args.name, { label: args.name, files: args.files.map((f) => relative(ROOT, join(ROOT, f)).replace(/\\/g, "/")), timeoutMs: args.timeoutMs, min: args.min }]]
    : (args.suites.length ? args.suites : Object.keys(SUITES)).map((s) => {
        if (!SUITES[s]) throw new Error(`unknown suite: ${s}`);
        return [s, { ...SUITES[s], files: SUITES[s].files() }];
      });

  const results = plan.map(([name, suite]) => runSuite(name, suite));

  console.log("\n=== summary ===");
  for (const r of results) {
    const s = r.summary;
    const counts = `tests ${s.tests ?? "?"}, pass ${s.pass ?? "?"}, fail ${s.fail ?? "?"}, cancelled ${s.cancelled ?? "?"}, skipped ${s.skipped ?? "?"}`;
    console.log(`${r.status.padEnd(7)} ${r.name.padEnd(7)} ${counts}${r.problems.length ? `  <- ${r.problems.join("; ")}` : ""}`);
  }
  const failed = results.some((r) => r.status === "FAIL");
  const blocked = results.some((r) => r.status === "BLOCKED");
  process.exitCode = failed ? 1 : blocked ? 2 : 0;
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(resolve(fileURLToPath(import.meta.url)), resolve(process.argv[1]))) {
  main();
}

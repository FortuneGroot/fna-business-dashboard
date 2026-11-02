import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  UsageError, checkServiceKey, checkTarget, confirmationPhrase, parseArgs, run, type Deps,
} from "../scripts/bootstrap-platform-admin";

// A2 target guards and command logic, against an in-memory fake of the Auth admin and Data APIs.

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SERVICE_KEY = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.sig-not-checked-here`;
const ANON_KEY = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;

type Fake = {
  users: { id: string; email: string; factors: string[]; sessions: number }[]; admins: string[]; audit: any[]; requests: string[];
  /** Failure injection: factor ids whose DELETE answers 500, audit actions whose insert answers 500, failing factor re-reads. */
  failFactorDeletes?: string[]; failAudit?: string[]; failFactorListAfter?: number;
};

function fakeFetch(state: Fake): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.requests.push(`${method} ${url.pathname}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${SERVICE_KEY}`);
    const json = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
    const p = url.pathname;
    if (p === "/auth/v1/admin/users" && method === "GET") {
      const page = Number(url.searchParams.get("page"));
      return json({ users: page === 1 ? state.users.map(({ id, email }) => ({ id, email })) : [] });
    }
    let m = /^\/auth\/v1\/admin\/users\/([^/]+)\/factors$/.exec(p);
    if (m) {
      const lists = state.requests.filter((r) => r === `GET ${p}`).length;
      if (state.failFactorListAfter !== undefined && lists > state.failFactorListAfter) return json({ msg: "unavailable" }, 503);
      return json(state.users.find((u) => u.id === m![1])!.factors.map((id) => ({ id })));
    }
    m = /^\/auth\/v1\/admin\/users\/([^/]+)\/factors\/([^/]+)$/.exec(p);
    if (m && method === "DELETE") {
      if (state.failFactorDeletes?.includes(m[2])) return json({ msg: "boom" }, 500);
      const u = state.users.find((x) => x.id === m![1])!;
      u.factors = u.factors.filter((f) => f !== m![2]);
      return json({});
    }
    if (p === "/rest/v1/platform_admins" && method === "GET") return json(state.admins.map((user_id) => ({ user_id, created_at: "t" })));
    if (p === "/rest/v1/platform_audit_log" && method === "POST") {
      const row = JSON.parse(String(init!.body));
      if (state.failAudit?.includes(row.action)) return json({ code: "XX000", message: "audit unavailable" }, 500);
      state.audit.push(row);
      return json(null, 201);
    }
    // Mirrors M22: the privilege change and its audit row succeed or fail together.
    if (p === "/rest/v1/rpc/platform_admin_grant" && method === "POST") {
      const { p_user_id, p_metadata } = JSON.parse(String(init!.body));
      if (state.admins.includes(p_user_id)) return json({ changed: false, admins: state.admins.length });
      if (state.failAudit?.includes("platform.admin_granted")) return json({ code: "XX000", message: "audit unavailable" }, 500);
      state.admins.push(p_user_id);
      state.audit.push({ actor_id: null, action: "platform.admin_granted", reason: null, metadata: { ...p_metadata, user_id: p_user_id } });
      return json({ changed: true, admins: state.admins.length });
    }
    if (p === "/rest/v1/rpc/platform_admin_revoke" && method === "POST") {
      const { p_user_id, p_reason, p_metadata } = JSON.parse(String(init!.body));
      if (!state.admins.includes(p_user_id)) return json({ changed: false, admins: state.admins.length });
      if (state.admins.length <= 1) return json({ code: "23514", message: "last_platform_admin: at least one platform admin must remain" }, 400);
      if (state.failAudit?.includes("platform.admin_revoked")) return json({ code: "XX000", message: "audit unavailable" }, 500);
      state.admins = state.admins.filter((a) => a !== p_user_id);
      state.audit.push({ actor_id: null, action: "platform.admin_revoked", reason: p_reason, metadata: { ...p_metadata, user_id: p_user_id } });
      return json({ changed: true, admins: state.admins.length });
    }
    // Mirrors M27: the sessions end together with their audit row, or not at all.
    if (p === "/rest/v1/rpc/platform_end_user_sessions" && method === "POST") {
      const { p_user_id, p_reason, p_metadata } = JSON.parse(String(init!.body));
      if (state.failAudit?.includes("platform.sessions_ended")) return json({ code: "XX000", message: "audit unavailable" }, 500);
      const u = state.users.find((x) => x.id === p_user_id)!;
      const ended = u.sessions;
      u.sessions = 0;
      state.audit.push({ actor_id: null, action: "platform.sessions_ended", reason: p_reason, metadata: { ...p_metadata, user_id: p_user_id, sessions_ended: ended } });
      return json({ ended });
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
}

function harness(opts: { url?: string; key?: string; prompt?: Deps["prompt"]; state?: Partial<Fake> } = {}) {
  const state: Fake = {
    users: [
      { id: "u-george", email: "george@example.test", factors: ["f1", "f2"], sessions: 3 },
      { id: "u-ops", email: "ops@example.test", factors: [], sessions: 1 },
    ],
    admins: [], audit: [], requests: [], ...opts.state,
  };
  const lines: string[] = [];
  const deps: Deps = {
    env: { SUPABASE_URL: opts.url ?? "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: opts.key ?? SERVICE_KEY },
    fetch: fakeFetch(state), log: (l) => lines.push(l), prompt: opts.prompt ?? null,
  };
  return { state, lines, deps };
}

describe("A2 bootstrap-platform-admin: arguments and target guards", () => {
  test("parses commands and rejects malformed input", () => {
    assert.deepEqual(parseArgs(["grant", "--email", " George@Example.TEST ", "--env", "local"]),
      { command: "grant", email: "george@example.test", env: "local", reason: null, dryRun: false });
    for (const bad of [
      [], ["delete", "--env", "local"], ["grant", "--env", "local"], ["grant", "--email", "nope", "--env", "local"],
      ["grant", "--email", "a@b.co", "--env", "prod"], ["grant", "--email", "a@b.co"], ["grant", "--email", "a@b.co", "--env", "local", "--force"],
      ["grant", "--email", "a@b.co", "--env", "local", "--env", "staging"], ["revoke", "--email", "a@b.co", "--env", "local"],
      ["remove-mfa", "--email", "a@b.co", "--env", "local", "--reason", "x"], ["list", "--env", "local", "--email", "a@b.co"],
      ["grant", "--email", "--env", "local"],
    ]) assert.throws(() => parseArgs(bad), UsageError, bad.join(" "));
  });

  test("local accepts only loopback origins; staging/production only https non-loopback origins", () => {
    for (const u of ["http://127.0.0.1:54321", "http://localhost:54321/", "http://[::1]:54321"]) assert.equal(checkTarget("local", u).local, true, u);
    assert.equal(checkTarget("staging", "https://abcdefgh.supabase.co").host, "abcdefgh.supabase.co");
    const refused: [Parameters<typeof checkTarget>[0], string | undefined][] = [
      ["local", undefined], ["local", ""], ["local", "not a url"], ["local", "https://abcdefgh.supabase.co"],
      ["local", "http://127.0.0.1.evil.example"], ["local", "http://user:pw@127.0.0.1:54321"], ["local", "http://127.0.0.1:54321/rest/v1"],
      ["local", "http://127.0.0.1:54321?x=1"], ["local", "ftp://127.0.0.1"], ["staging", "http://127.0.0.1:54321"],
      ["production", "http://abcdefgh.supabase.co"], ["production", "https://localhost"],
    ];
    for (const [env, u] of refused) assert.throws(() => checkTarget(env, u), UsageError, `${env} ${u}`);
  });

  test("only a service-role key is accepted, and no message ever contains a key", () => {
    assert.equal(checkServiceKey(` ${SERVICE_KEY} `), SERVICE_KEY);
    assert.equal(checkServiceKey("sb_secret_abc"), "sb_secret_abc");
    for (const k of [undefined, "", ANON_KEY, "garbage"]) {
      try {
        checkServiceKey(k);
        assert.fail("accepted");
      } catch (err) {
        assert.ok(err instanceof UsageError);
        if (k) assert.equal(err.message.includes(k), false);
      }
    }
  });
});

describe("A2 bootstrap-platform-admin: commands", () => {
  test("grant: makes the user a platform admin once, audited; a repeat is a no-op", async () => {
    const h = harness();
    assert.equal(await run(["grant", "--email", "george@example.test", "--env", "local"], h.deps), 0);
    assert.deepEqual(h.state.admins, ["u-george"]);
    assert.equal(h.state.audit.length, 1);
    assert.deepEqual(h.state.audit[0], {
      actor_id: null, action: "platform.admin_granted", reason: null,
      metadata: { via: "scripts/bootstrap-platform-admin.ts", env: "local", user_id: "u-george", email: "george@example.test" },
    });
    assert.equal(await run(["grant", "--email", "george@example.test", "--env", "local"], h.deps), 0);
    assert.deepEqual([h.state.admins.length, h.state.audit.length], [1, 1]);
    assert.ok(h.lines.every((l) => !l.includes(SERVICE_KEY)));
  });

  test("an unknown email is refused without writing; dry run writes nothing", async () => {
    const h = harness();
    assert.equal(await run(["grant", "--email", "nobody@example.test", "--env", "local"], h.deps), 3);
    assert.equal(await run(["grant", "--email", "george@example.test", "--env", "local", "--dry-run"], h.deps), 0);
    assert.deepEqual([h.state.admins, h.state.audit], [[], []]);
    assert.ok(h.state.requests.every((r) => r.startsWith("GET ")));
  });

  test("revoke refuses to remove the last platform admin, otherwise removes and audits with the reason", async () => {
    const h = harness({ state: { admins: ["u-george"] } });
    assert.equal(await run(["revoke", "--email", "george@example.test", "--env", "local", "--reason", "Leaving the team"], h.deps), 4);
    assert.deepEqual(h.state.admins, ["u-george"]);
    h.state.admins.push("u-ops");
    assert.equal(await run(["revoke", "--email", "george@example.test", "--env", "local", "--reason", "Leaving the team"], h.deps), 0);
    assert.deepEqual(h.state.admins, ["u-ops"]);
    assert.deepEqual([h.state.audit[0].action, h.state.audit[0].reason], ["platform.admin_revoked", "Leaving the team"]);
  });

  test("grant and revoke change platform_admins only through the transactional database functions", async () => {
    const h = harness({ state: { admins: ["u-ops"] } });
    assert.equal(await run(["grant", "--email", "george@example.test", "--env", "local"], h.deps), 0);
    assert.equal(await run(["revoke", "--email", "george@example.test", "--env", "local", "--reason", "Rotation complete"], h.deps), 0);
    assert.deepEqual(h.state.requests.filter((r) => !r.startsWith("GET ")),
      ["POST /rest/v1/rpc/platform_admin_grant", "POST /rest/v1/rpc/platform_admin_revoke"]);
  });

  test("a failed grant or revoke (e.g. the audit insert fails) reports failure and changes nothing", async () => {
    const g = harness({ state: { admins: ["u-ops"], failAudit: ["platform.admin_granted"] } });
    await assert.rejects(run(["grant", "--email", "george@example.test", "--env", "local"], g.deps), /HTTP 500/);
    assert.deepEqual([g.state.admins, g.state.audit], [["u-ops"], []]);
    const r = harness({ state: { admins: ["u-george", "u-ops"], failAudit: ["platform.admin_revoked"] } });
    await assert.rejects(run(["revoke", "--email", "george@example.test", "--env", "local", "--reason", "Rotation complete"], r.deps), /HTTP 500/);
    assert.deepEqual([r.state.admins, r.state.audit], [["u-george", "u-ops"], []]);
  });

  test("remove-mfa records a start, ends every session, deletes every factor, re-reads, and records the complete outcome", async () => {
    const h = harness({ state: { admins: ["u-george"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], h.deps), 0);
    assert.deepEqual([h.state.users[0].factors, h.state.users[0].sessions], [[], 0]);
    assert.equal(h.state.users[1].sessions, 1, "other users keep their sessions");
    assert.deepEqual(h.state.audit.map((a) => a.action),
      ["platform.mfa_removal_started", "platform.sessions_ended", "platform.mfa_factors_removed"]);
    const [start, ended, done] = h.state.audit;
    assert.deepEqual(start.metadata.factor_ids, ["f1", "f2"]);
    assert.deepEqual([ended.metadata.operation_id, ended.metadata.sessions_ended, ended.reason], [start.metadata.operation_id, 3, "Lost phone, verified by call"]);
    assert.equal(done.metadata.operation_id, start.metadata.operation_id);
    assert.deepEqual([done.metadata.outcome, done.metadata.sessions_ended, done.metadata.removed_factor_ids, done.metadata.remaining_factor_ids],
      ["complete", 3, ["f1", "f2"], []]);
    assert.equal(done.reason, "Lost phone, verified by call");
    assert.match(h.lines.at(-1)!, /^ended 3 session\(s\) and removed 2 factor\(s\)/);
    const writes = h.state.requests.filter((r) => !r.startsWith("GET "));
    assert.deepEqual(writes, ["POST /rest/v1/platform_audit_log", "POST /rest/v1/rpc/platform_end_user_sessions",
      "DELETE /auth/v1/admin/users/u-george/factors/f1", "DELETE /auth/v1/admin/users/u-george/factors/f2", "POST /rest/v1/platform_audit_log"],
      "sessions end before any factor is deleted");
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone again"], h.deps), 0);
    assert.equal(h.state.audit.length, 3, "nothing to remove is not audited");
  });

  test("remove-mfa deletes no factor when the sessions cannot be ended: recorded as sessions_not_ended, exit 5", async () => {
    const h = harness({ state: { failAudit: ["platform.sessions_ended"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], h.deps), 5);
    assert.deepEqual([h.state.users[0].factors, h.state.users[0].sessions], [["f1", "f2"], 3]);
    assert.ok(h.state.requests.every((r) => !r.startsWith("DELETE ")));
    assert.deepEqual(h.state.audit.map((a) => [a.action, a.metadata.outcome]),
      [["platform.mfa_removal_started", undefined], ["platform.mfa_removal_incomplete", "sessions_not_ended"]]);
    assert.match(h.lines.at(-1)!, /^incomplete: sessions could not be ended .*no factor was removed/);
  });

  test("end-sessions signs one user out everywhere, audited with the reason; dry run changes nothing", async () => {
    const h = harness();
    assert.throws(() => parseArgs(["end-sessions", "--email", "george@example.test", "--env", "local"]), UsageError);
    assert.equal(await run(["end-sessions", "--email", "george@example.test", "--env", "local", "--reason", "Laptop stolen", "--dry-run"], h.deps), 0);
    assert.deepEqual([h.state.users[0].sessions, h.state.audit], [3, []]);
    assert.equal(await run(["end-sessions", "--email", "george@example.test", "--env", "local", "--reason", "Laptop stolen"], h.deps), 0);
    assert.deepEqual([h.state.users[0].sessions, h.state.users[0].factors, h.state.users[1].sessions], [0, ["f1", "f2"], 1]);
    assert.deepEqual([h.state.audit[0].action, h.state.audit[0].reason, h.state.audit[0].metadata.sessions_ended], ["platform.sessions_ended", "Laptop stolen", 3]);
    assert.match(h.lines.at(-1)!, /^ended 3 session\(s\) of george@example\.test/);
  });

  test("remove-mfa never reports success when a factor survives: partial and none are recorded and exit 5", async () => {
    const partial = harness({ state: { failFactorDeletes: ["f2"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], partial.deps), 5);
    assert.deepEqual(partial.state.users[0].factors, ["f2"]);
    const rec = partial.state.audit[2];
    assert.deepEqual([rec.action, rec.metadata.outcome, rec.metadata.removed_factor_ids, rec.metadata.remaining_factor_ids, rec.metadata.failed_calls],
      ["platform.mfa_removal_incomplete", "partial", ["f1"], ["f2"], 1]);
    assert.match(partial.lines.at(-1)!, /^incomplete: removed 1 of 2 factor\(s\); still present: f2/);
    assert.ok(partial.lines.every((l) => !/^removed /.test(l)));

    const none = harness({ state: { failFactorDeletes: ["f1", "f2"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], none.deps), 5);
    assert.equal(none.state.audit[2].metadata.outcome, "none");
  });

  test("remove-mfa: no start record means no deletion; an unconfirmed or unrecorded outcome is not success", async () => {
    const noStart = harness({ state: { failAudit: ["platform.mfa_removal_started"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], noStart.deps), 1);
    assert.deepEqual([noStart.state.users[0].factors, noStart.state.users[0].sessions], [["f1", "f2"], 3]);
    assert.ok(noStart.state.requests.every((r) => !r.startsWith("DELETE ") && !r.includes("/rpc/")));

    const unknown = harness({ state: { failFactorListAfter: 1 } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], unknown.deps), 5);
    assert.deepEqual([unknown.state.audit[2].action, unknown.state.audit[2].metadata.outcome], ["platform.mfa_removal_incomplete", "unknown"]);
    assert.match(unknown.lines.at(-1)!, /outcome is unknown/);

    const unrecorded = harness({ state: { failAudit: ["platform.mfa_factors_removed"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], unrecorded.deps), 6);
    assert.deepEqual(unrecorded.state.users[0].factors, []);
    assert.deepEqual(unrecorded.state.audit.map((a) => a.action), ["platform.mfa_removal_started", "platform.sessions_ended"]);
    assert.match(unrecorded.lines.at(-1)!, /completion record could not be written/);
  });

  test("non-local targets: refused without a terminal, refused on a wrong phrase, proceed only on the exact phrase", async () => {
    const hosted = "https://abcdefgh.supabase.co";
    const argv = ["grant", "--email", "george@example.test", "--env", "staging"];
    const noTty = harness({ url: hosted });
    assert.equal(await run(argv, noTty.deps), 2);
    assert.deepEqual(noTty.state.requests, [], "no request is made before confirmation");

    const wrong = harness({ url: hosted, prompt: async () => "yes" });
    assert.equal(await run(argv, wrong.deps), 2);
    assert.deepEqual(wrong.state.requests, []);

    let asked = "";
    const phrase = confirmationPhrase(parseArgs(argv), checkTarget("staging", hosted));
    assert.equal(phrase, "grant george@example.test on staging abcdefgh.supabase.co");
    const right = harness({ url: hosted, prompt: async (q) => ((asked = q), phrase) });
    assert.equal(await run(argv, right.deps), 0);
    assert.match(asked, /abcdefgh\.supabase\.co/);
    assert.deepEqual(right.state.admins, ["u-george"]);
    assert.equal(right.state.audit[0].metadata.env, "staging");
  });

  test("mismatched env and URL, or a non-service key, are refused before any request", async () => {
    for (const [argv, url, key] of [
      [["grant", "--email", "george@example.test", "--env", "local"], "https://abcdefgh.supabase.co", SERVICE_KEY],
      [["grant", "--email", "george@example.test", "--env", "production"], "http://127.0.0.1:54321", SERVICE_KEY],
      [["grant", "--email", "george@example.test", "--env", "local"], "http://127.0.0.1:54321", ANON_KEY],
    ] as [string[], string, string][]) {
      const h = harness({ url, key, prompt: async () => "anything" });
      assert.equal(await run(argv, h.deps), 2);
      assert.deepEqual(h.state.requests, []);
      assert.ok(h.lines.every((l) => !l.includes(key)));
    }
  });
});

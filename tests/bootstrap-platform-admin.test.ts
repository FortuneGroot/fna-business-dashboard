import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  UsageError, checkServiceKey, checkTarget, confirmationPhrase, parseArgs, run, type Deps,
} from "../scripts/bootstrap-platform-admin";

// A2 target guards and command logic, against an in-memory fake of the Auth admin and Data APIs.

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SERVICE_KEY = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.sig-not-checked-here`;
const ANON_KEY = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;

type Fake = { users: { id: string; email: string; factors: string[] }[]; admins: string[]; audit: any[]; requests: string[] };

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
    if (m) return json(state.users.find((u) => u.id === m![1])!.factors.map((id) => ({ id })));
    m = /^\/auth\/v1\/admin\/users\/([^/]+)\/factors\/([^/]+)$/.exec(p);
    if (m && method === "DELETE") {
      const u = state.users.find((x) => x.id === m![1])!;
      u.factors = u.factors.filter((f) => f !== m![2]);
      return json({});
    }
    if (p === "/rest/v1/platform_admins" && method === "GET") return json(state.admins.map((user_id) => ({ user_id, created_at: "t" })));
    if (p === "/rest/v1/platform_admins" && method === "POST") {
      state.admins.push(JSON.parse(String(init!.body)).user_id);
      return json(null, 201);
    }
    if (p === "/rest/v1/platform_admins" && method === "DELETE") {
      const id = url.searchParams.get("user_id")!.replace(/^eq\./, "");
      state.admins = state.admins.filter((a) => a !== id);
      return json(null, 204);
    }
    if (p === "/rest/v1/platform_audit_log" && method === "POST") {
      state.audit.push(JSON.parse(String(init!.body)));
      return json(null, 201);
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
}

function harness(opts: { url?: string; key?: string; prompt?: Deps["prompt"]; state?: Partial<Fake> } = {}) {
  const state: Fake = {
    users: [{ id: "u-george", email: "george@example.test", factors: ["f1", "f2"] }, { id: "u-ops", email: "ops@example.test", factors: [] }],
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

  test("remove-mfa deletes every factor and audits the factor ids with the reason", async () => {
    const h = harness({ state: { admins: ["u-george"] } });
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone, verified by call"], h.deps), 0);
    assert.deepEqual(h.state.users[0].factors, []);
    assert.deepEqual(h.state.audit[0].metadata.factor_ids, ["f1", "f2"]);
    assert.equal(h.state.audit[0].action, "platform.mfa_factors_removed");
    assert.equal(await run(["remove-mfa", "--email", "george@example.test", "--env", "local", "--reason", "Lost phone again"], h.deps), 0);
    assert.equal(h.state.audit.length, 1, "nothing to remove is not audited");
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

#!/usr/bin/env node
/**
 * Repeatable Production/Preview auth verification (no secrets in repo).
 *
 * Usage:
 *   node scripts/verify-auth-runtime.mjs https://fna-client-app.vercel.app
 *
 * Optional interactive login check (values never written to disk/logs):
 *   set VERIFY_AUTH_INTERACTIVE=1
 *
 * Never prints cookie, password, AUTH_SECRET, or service-role values.
 */
import { createInterface } from "node:readline/promises";
import process from "node:process";

const base = (process.argv[2] || "https://fna-client-app.vercel.app").replace(/\/$/, "");
const interactive = (process.env.VERIFY_AUTH_INTERACTIVE || "").trim() === "1";

function redact(s) {
  return String(s || "")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted-long]");
}

async function get(path, headers = {}) {
  const res = await fetch(base + path, { headers, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, location: res.headers.get("location"), json, text };
}

function assert(cond, label) {
  if (!cond) throw new Error("FAIL: " + label);
  console.log("PASS:", label);
}

async function main() {
  console.log("TARGET", base);

  const me = await get("/api/auth/me");
  assert(me.status === 401 || me.status === 200 || me.status === 503, "auth/me responds");
  if (me.status === 401) {
    assert(me.json?.authEnforced === true || me.json?.error === "Unauthorized", "auth/me 401 shape");
    assert(me.json?.authEnforced !== false, "auth/me does not claim auth off on 401");
  }
  if (me.status === 200 && me.json?.authEnforced === false) {
    console.log("INFO: auth not enforced on this host (expected only for open Preview/local)");
  }
  if (me.status === 503) {
    assert(me.json?.authFailClosed === true, "503 is fail-closed misconfig");
  }

  const dash = await get("/dashboard");
  assert(dash.status === 307 || dash.status === 302, "anonymous /dashboard redirects");
  assert(
    String(dash.location || "").includes("/login"),
    "dashboard redirect targets login (not open)"
  );
  assert(!String(dash.location || "").includes("auth_misconfigured") || me.status === 503, "misconfig only if AUTH missing");

  const health = await get("/api/health");
  assert(health.status === 200, "public health 200");
  const h = JSON.stringify(health.json || {});
  assert(!/NQwD3zdWCuBSVpOuzybj/.test(h), "health has no Master id");
  assert(!/iYIxeKOdg5jkoAfKNnYM/.test(h), "health has no old pipeline id");
  assert(!/SUPABASE_SERVICE_ROLE|AUTH_SECRET|pit-/.test(h), "health has no secret markers");

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const email = await rl.question("Owner email (not logged): ");
      const password = process.env.VERIFY_AUTH_PASSWORD || "";
      if (!password) {
        console.log("SKIP_LOGIN: set VERIFY_AUTH_PASSWORD in the environment for interactive login (value never printed)");
      } else {
        const loginRes = await fetch(base + "/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
          redirect: "manual",
        });
        const setCookie = loginRes.headers.getSetCookie?.() || [];
        const hasCookie =
          setCookie.some((c) => /fna|session|AUTH/i.test(c)) || Boolean(loginRes.headers.get("set-cookie"));
        assert(loginRes.status === 200, "login HTTP 200");
        assert(hasCookie, "login issued session cookie (name only checked)");
        console.log("PASS: interactive login issued cookie (cookie value not printed)");
      }
      void email;
    } finally {
      rl.close();
      delete process.env.VERIFY_AUTH_PASSWORD;
    }
  }

  console.log("VERIFY_AUTH_RUNTIME_OK", redact(base));
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});

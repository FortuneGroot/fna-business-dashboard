import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAuthRejected } from "./helpers/recovery-assertions";

test("recovery proof accepts session/token rejection and refuses outages, wrong errors and malformed responses", async () => {
  const response = (status: number, code: string) => new Response(JSON.stringify({ code }), { status });
  await assertAuthRejected(response(403, "session_not_found"), "access");
  await assertAuthRejected(new Response(JSON.stringify({ code: 403, error_code: "session_not_found" }), { status: 403 }), "access");
  await assertAuthRejected(response(400, "refresh_token_not_found"), "refresh");
  for (const status of [200, 404, 429, 500, 502, 503]) {
    await assert.rejects(assertAuthRejected(response(status, "session_not_found"), "access"));
  }
  await assert.rejects(assertAuthRejected(response(403, "mfa_factor_limit_exceeded"), "access"));
  await assert.rejects(assertAuthRejected(new Response("not JSON", { status: 401 }), "access"));
});

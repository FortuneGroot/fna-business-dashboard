import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { jwtPayload, signJwt, totp } from "./supabase-stack/stack";

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

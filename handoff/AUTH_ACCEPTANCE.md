# Auth acceptance

## Scope

Local unit tests + Production anonymous probes are covered. **Credentialed Production login / refresh / logout / replay remain owner-only** and were not executed overnight (no usable non-placeholder credentials in this session).

## Preserved contracts

| Contract | Status |
|---|---|
| `sb_secret_` → `apikey` only (no Bearer with that key) | Preserved + tested |
| Legacy `eyJ` JWT service-role → `apikey` + `Authorization: Bearer` | Preserved + tested |
| Production / Preview fail closed without durable Supabase store | Preserved + tested |
| No memory / signature-only shortcut in those environments | Preserved + tested |
| Role from stored session (OWNER > ADMIN > CLIENT) | Preserved + tested |
| Cookie httpOnly / SameSite=Lax / Secure in production | Preserved in code |
| Secrets absent from logs/URLs/bundles | Bundle gate + scans |

## Logout honesty (this branch)

**Before:** Logout always cleared the browser cookie and returned `{ ok, loggedOut }` even when durable revoke failed — easy to misread as full server logout.

**After:** Logout returns:

```json
{
  "ok": true,
  "loggedOut": true,
  "cookieCleared": true,
  "durableRevoked": true|false,
  "durableRevokeStatus": "revoked|failed|skipped_no_cookie|skipped_no_secret"
}
```

`revokeSessionToken` now propagates durable-store transport failures instead of swallowing them.

**Interpretation:**

- `durableRevoked=true` → captured old cookie must fail Edge/Node verify.
- `durableRevoked=false` → local cookie cleared; **do not claim** server-side logout success; replay may still work until TTL.

## Failure classes (diagnostic guide)

| Class | Typical evidence |
|---|---|
| Missing configuration | `AUTH_SECRET` / Supabase env absent; `/api/auth/me` 503 fail-closed |
| Malformed configuration | Non-http `SUPABASE_URL`; blank keys |
| Wrong project/key pairing | Create/confirm HTTP 401/403 from PostgREST |
| Permission/schema failure | Missing `auth_sessions` table/columns; RLS/grants |
| Session insert/readback failure | Upsert OK but confirm GET empty → create throws; no cookie |
| Cookie/host/signature failure | HMAC mismatch; Secure cookie on http; wrong host |
| Revocation/replay failure | Logout `durableRevoked=false` or replay still 200 |

Do not label Production issues “configuration only” without matching evidence.

## Owner email facts (not credentials)

- Primary contact: `george@fortuneandfinance.com`
- Work contact: `automations@fortuneandfinance.com`
- `AUTH_OWNER_EMAIL` is an independent login contract — **do not auto-rewrite** from contact emails.
- `owner-values.ts` support/lead emails are still empty placeholders pending owner fill.

## How to run credentialed acceptance

```bash
# Prefer setting password in a short-lived env, not shell history when possible
set VERIFY_AUTH_INTERACTIVE=1
set VERIFY_AUTH_PASSWORD=...
node scripts/verify-auth-runtime.mjs https://fna-client-app.vercel.app
```

Expect separate PASS/WARN lines for login, me, durableRevoked, and replay.

## Local proof (this branch)

- `tests/auth.test.ts`: logout revoke + durable revoke failure throws
- Full suite: see `CURSOR_FINAL.md`

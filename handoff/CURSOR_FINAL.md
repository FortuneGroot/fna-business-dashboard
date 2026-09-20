# CURSOR_FINAL — overnight install & gates

## Identity

| Field | Value |
|---|---|
| Isolated worktree | `c:\Users\gnass\Downloads\f&a ghl full build\fna-app-overnight` |
| Branch | `feat/overnight-install-and-gates` |
| **Starting SHA** | `9c189f8e6a38de3f93933e437da79017d193e793` |
| **Ending SHA** | `9a0ed2988bbc083df7bcbfd013a24397b5aebd4e` |
| Audited base / release at start | `9c189f8` (already contained prior candidate) |
| Historical main | `19866377f9ba0a6b83fbedae3c0f294ee4cbf555` (untouched) |
| Primary WIP preserved | `src/lib/onboarding/types.ts` still modified in primary worktree only |

## Root causes fixed

1. **Logout honesty gap** — Cookie clear was treated as full logout; durable revoke failures were swallowed.
2. **Release gate skip** — Bundle Master/secret scans soft-skipped when `.next/static` missing under `npm test`.
3. **Missing webhook install fixtures** — Event-family fixtures and cross-tenant isolation tests were incomplete for Grok/Claude handoff.
4. **Install preflight** — No single non-mutating doctor summarizing deployment-per-client readiness without printing secrets.

## Behavior before → after

| Area | Before | After |
|---|---|---|
| Logout API | `{ok, loggedOut}` always | Adds `cookieCleared`, `durableRevoked`, `durableRevokeStatus` |
| `revokeSessionToken` | Swallowed durable errors | Returns `{durableRevoked}`; durable transport errors propagate |
| Release scan | Soft-skip without build | `npm run release:security` clean-builds and **fails** if assets missing/hits found |
| Webhooks | Inline tests only | Fixtures + contract tests + cross-tenant isolation |
| Install | validate/readiness scripts | + `npm run install:doctor` |

## Commands and results (local)

| Command | Result |
|---|---|
| `npm test` | **150 pass / 0 fail / 40 suites** |
| `tsc --noEmit` | **exit 0** |
| `npm run release:security` | **RELEASE_SECURITY_PASS** — 61 static files, all hitCounts 0 |
| `npm run install:doctor -- config/examples/synthetic-ready-client.json` | Runs; exit 1 expected locally (AUTH/webhook env missing) — prints flags only |

## Local vs Production

| Check | Local | Production |
|---|---|---|
| Unit/integration suite | PASS (150) | N/A |
| Bundle gate | PASS via `release:security` | Prior deploy at `9c189f8` already scanned anonymously |
| Credentialed login/refresh/logout/replay | Not run (no usable credentials) | **NOT VERIFIED** — owner must run `verify:auth` interactive |
| Valid webhook to Production | **Not sent** (authorized) | Unsigned still expected 401 |

## Remaining credential-dependent checks

1. Production interactive login with real `AUTH_OWNER_*`.
2. Confirm `durableRevoked=true` on Production logout.
3. Confirm captured-cookie replay returns 401 after durable revoke.
4. Confirm Supabase migrations applied on Production project.
5. Decide whether `AUTH_OWNER_EMAIL` matches primary or work contact (do not auto-rewrite).

## Files for Claude review

Commit tip `9a0ed29` on `feat/overnight-install-and-gates` (implementation `b88f8b0` + handoff docs):

- `src/app/api/auth/logout/route.ts`, `src/lib/auth/session.ts`, `src/lib/auth/index.ts`
- `scripts/release-security-gate.mjs`, `scripts/install-doctor.ts`, `scripts/verify-auth-runtime.mjs`
- `tests/webhook-contract.test.ts`, `tests/fixtures/webhooks/*`, `tests/auth.test.ts`, `tests/security-scan.test.ts`
- `handoff/*.md`, `package.json`

## Schema changes

**None new.** Existing migrations remain **unapplied by this agent**.

## Migration / deploy risks

- Merging this branch does not change Production until Claude merges to `release` and deploys.
- Logout response shape change is additive JSON fields (backward compatible).
- Rollback: revert merge on `release` to `9c189f8`.

## Owner actions (necessary only)

1. Credentialed Production acceptance via `VERIFY_AUTH_INTERACTIVE=1`.
2. Confirm auth email mapping (contact ≠ password identity).
3. Claude review → merge `feat/overnight-install-and-gates` when approved.
4. Do not share F&A live webhook secret with other clients.

## Safety

- Secrets exposed: 0  
- Force push: 0  
- `main` changes: 0  
- Production deploy by Cursor: 0  
- Paid APIs / GHL writes: 0  
- Valid Production webhook writes: 0  

## Push status

Feature branch pushed to `origin/feat/overnight-install-and-gates` @ `72d4d04`.  
`origin/release` remains `9c189f8`. `origin/main` remains `1986637`. No Production deploy by Cursor.

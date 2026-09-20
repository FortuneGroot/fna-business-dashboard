# Release handoff (Cursor → Claude)

## Review candidate

| Field | Value |
|---|---|
| Branch | `feat/overnight-install-and-gates` |
| Base / audited Production tip | `9c189f8e6a38de3f93933e437da79017d193e793` (`origin/release` at start of overnight work) |
| Ending SHA | `b88f8b04c3d6941f92af5556cc791c9b2b606c1b` |
| Do not merge concurrently | Cursor does not merge `release` or deploy Production |

## What Claude should review

1. Logout honesty (`durableRevoked` response) — no security weakening.
2. `scripts/release-security-gate.mjs` — non-skippable build+scan.
3. Webhook fixtures + `tests/webhook-contract.test.ts` cross-tenant isolation.
4. `scripts/install-doctor.ts` + handoff docs.
5. `verify-auth-runtime.mjs` credentialed path reporting.

## What Claude should deploy (when approved)

- Fast-forward/merge **this feature branch** into `release` only after review.
- Do not touch `main`.
- Do not edit Vercel env values unless diagnosing a named missing key.
- Confirm Supabase migrations applied before treating durable auth as Production-ready.

## Schema changes

| Change | Applied remotely? |
|---|---|
| None new in this overnight branch | N/A |
| Existing SQL under `supabase/migrations/` | **Unapplied by Cursor** — apply status unknown |

## Rollback

```bash
# If this branch was merged to release, revert the merge commit on release
# or fast-forward release back to 9c189f8 (only with owner approval).
```

Prior Production alias remains valid at `9c189f8` until a new release deploy.

## Owner actions remaining

1. Credentialed Production acceptance (`VERIFY_AUTH_INTERACTIVE=1`).
2. Confirm which email is `AUTH_OWNER_EMAIL` (contact emails are not credentials).
3. Fill `owner-values.ts` support/lead emails when verified.
4. Confirm Supabase `auth_sessions` + sync migrations applied on the Production project.
5. Authorize any new client deployment separately (do not share F&A live webhook secret).

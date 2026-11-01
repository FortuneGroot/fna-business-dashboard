# Native Multi-Tenant — P1 Checklist

Companion to `docs/NATIVE_MULTI_TENANT_SPEC.md` (§14 decisions, §15 implementation record).
Status as of 2026-11-01. Branch `feat/native-multi-tenant`, all changes uncommitted, nothing pushed or deployed.
**Stop point: end of P1. P2 (authentication) and UI work have not started.**

Legend: `[x]` done and verified locally · `[ ]` not done · **BLOCKED** cannot be verified on this machine (never counted as passed).

## Binding decisions

- [x] Preserve the existing theme and navigation (sidebar items, order, labels, routes, layout, colours). P1 changed no UI files.
- [x] Workspaces architecture only. Conflicting `organizations` SQL is rejected; `tests/db/security-findings.test.ts` fails if any migration mentions `organizations`, `organization_id`, or `org_id`.
- [x] George = platform super-admin **and** F&A workspace owner (platform flag via bootstrap script; ownership via the F&A owner invitation). Legacy users get no automatic membership.
- [x] Support phone 781-964-0654 recorded (code change in `src/lib/brand.ts` deferred to the UI phase).
- [x] TJ Towing / Vinny Moving are synthetic fixtures only (`TJ Towing (synthetic)`, `Vinny Moving (synthetic)`, `example.test` emails).
- [x] D1–D7 resolved as instructed by the GC (spec §14): D1 local Docker + Supabase CLI; D2 config + exactly 12 stages, no calendars/business records; D3 lead intake later phase; D4 separate staging project later; D5 paid Supabase before cutover, no purchase; D6 as above; D7 as above.

## P1 security review findings

- [x] 1. Legacy `sync_*` / `auth_sessions` preserved; anon/authenticated revoked; default-deny RLS; service role retained (M14).
- [x] 2. Owner-affecting membership changes serialize on a workspace lock taken before mutation; last-owner rechecked under the lock. Concurrent removals tested on real local PostgreSQL with independent sessions (plus negative control).
- [x] 3. Nested PGlite sessions rejected immediately; per-session timeout; `--test-timeout` on every suite.
- [x] 4. Audited, platform-only bootstrap invitation rotation for workspaces that never had an owner; previous tokens revoked in the same transaction.
- [x] 5. Note/message authors: active member or live platform write grant, with actor and grant attribution; assignees still require membership.
- [x] 6. Actor attribution columns database-controlled; forged values rejected (no grant) and stamped from `auth.uid()`.
- [x] 7. Same-workspace composite FKs for audit `grant_id` and author `author_grant_id`.
- [x] 8. Clients cannot mark integrations verified/connected; AI receptionist enablement blocked by constraint until trusted verification and a runtime exist.
- [x] Regression tests for every finding.
- [x] `npm test` runs unit + database + concurrency suites and fails on failed, cancelled, skipped, or missing tests.

## Checks

| Check | Environment | Status |
| --- | --- | --- |
| `npm test` | runner (unit 143, db 129, realpg 7) | [x] PASS |
| `npm run test:db` | PGlite + Supabase shim | [x] PASS 129/129 |
| `npm run test:db:concurrency` | real local PostgreSQL 18.6, independent sessions | [x] PASS 7/7 |
| `tsc` (app and test files) | — | [x] PASS |
| `npm run build` | Next.js 15.5.25 | [x] PASS |
| Lint | — | not available (no script) |
| `supabase start` / `supabase db reset` | real Supabase local stack | **BLOCKED** — Docker/WSL/Supabase CLI not installed |
| PostgREST + real JWT checks (anon key, user JWT, forged/expired JWT, AAL2) | real Supabase local stack | **BLOCKED** |
| Storage bucket + policies | real Supabase local stack | **BLOCKED** |
| GoTrue sign-up → profile trigger | real Supabase local stack | **BLOCKED** |

## Remaining blockers / before P2

- [ ] Install Docker Desktop + Supabase CLI (D1), then run the BLOCKED rows above.
- [ ] Install the Microsoft VC++ 2015-2022 x64 runtime (the real-PostgreSQL suite currently borrows the copy shipped with Microsoft Edge via its own PATH).
- [ ] Resolve the legacy migration version collision (`20260917_auth_sessions.sql` and `20260917_sync_store.sql` share version `20260917`) on the staging project before any push.
- [ ] Staging Supabase project (D4) and paid plan (D5) — later, by instruction.

## Not done by instruction

No production access, deployment, push, commit, real invitations, outbound communications, purchases, authentication changes, or UI changes.

# Native Multi-Tenant — P1 Checklist

Companion to `docs/NATIVE_MULTI_TENANT_SPEC.md` (§14 decisions, §15 implementation record).
Status as of 2026-11-01. Branch `feat/native-multi-tenant`, committed locally only; nothing pushed or deployed.
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
- [x] `npm test` runs unit + database + concurrency + real-stack suites and fails on failed, cancelled, skipped, or missing tests.

## P1 verification round

- [x] Diff reviewed (no secrets; only intended files); P1 committed locally (`a1fe8b3`), not pushed.
- [x] VC++ 2015-2022 x64 redistributable installed (official winget package); Edge workaround removed.
- [x] Supabase CLI 2.122.0 installed (exact-pinned devDependency); `supabase/config.toml` created.
- [x] WSL 2.7.14 and Docker Desktop 4.97 installed.
- [x] Docker engine running (29.9.2; virtualization enabled).
- [x] Legacy migration versions made unique and ordered; mapping in `docs/MIGRATION_VERSION_MAPPING.md`; enforced by test.
- [ ] Remote migration history reconciled — cutover prerequisite (history unknown; no blind repair).
- [x] Real-stack suite (`tests/supabase-stack/`, 17 tests) run on a disposable stack: 15 PASS, 2 FAIL (R2-3).

## Second review (Codex) findings

- [x] R2-1 (P1): authority re-checked immediately after the workspace lock in every membership RPC; demotion-versus-promotion race reproduced and refused on real PostgreSQL (with negative control).
- [x] R2-2 (P2): runner keeps real failures FAIL even when output contains `BLOCKED:` (per-root-cause classification; fixtures).
- [x] R2-3 (P2): platform-granted Storage mutations audited (actor, workspace, grant, operation, object path); Storage policy isolation covered on shim tables.
- [x] R2-4 (P2): stack suite resets only an isolated, explicitly disposable project it started (guards unit-tested).
- [x] Storage policies through the real Storage API — PASS.
- [ ] R2-3 through the real Storage API — **FAIL, reopened**: the Storage API commits row writes as `service_role` without the caller's identity, so the trigger records nothing. Remediation decision pending.

## Second review coverage follow-up

- [x] Real (clock-driven) grant expiry: real PostgreSQL, grant row untouched.
- [x] Storage update/upsert; Storage access after grant revocation, member removal, and suspension (PGlite).
- [x] Permission overrides: RLS, RPCs, Storage, workspace scoping, promotion/removal clearing, who may set them, audit (PGlite); override races (real PostgreSQL).
- [x] Concurrent provisioning, invitation acceptance/revocation, and bootstrap rotation (real PostgreSQL).
- [x] Contact-write audit asserts the exact action, actor, and target (PGlite and stack suite).
- [x] The same coverage through GoTrue/PostgREST/Storage — PASS, except the two Storage-audit tests (R2-3).

## Checks

| Check | Environment | Status |
| --- | --- | --- |
| `npm test` | runner (unit 155, db 168, realpg 24, stack 17) | exit 1: three suites PASS, stack 15/17 (2 FAIL, R2-3) |
| `npm run test:db` | PGlite + Supabase shim | [x] PASS 168/168 |
| `npm run test:db:concurrency` | real local PostgreSQL 18.6, independent sessions | [x] PASS 24/24 |
| `tsc` (app and test files) | — | [x] PASS |
| `npm run build` | Next.js 15.5.25 | [x] PASS |
| Lint | — | not available (no script) |
| `npm run test:stack`: CLI `db reset` applies all migrations | real Supabase local stack | [x] PASS |
| GoTrue sign-up → profile; forged/expired/unsigned JWT; AAL1 vs TOTP AAL2 | real Supabase local stack | [x] PASS |
| RLS isolation, forged attribution, revoked membership, suspension, platform grants | real Supabase local stack | [x] PASS |
| Storage bucket + policies, PUT/upsert, overrides, clock expiry, concurrency | real Supabase local stack | [x] PASS |
| Legacy tables closed to anon/authenticated over PostgREST | real Supabase local stack | [x] PASS |
| Platform-grant Storage audit through the Storage API | real Supabase local stack | **FAIL** (R2-3 reopened) |

## Remaining blockers / before P2

- [ ] Decide and apply the R2-3 remediation for Storage API writes, then rerun `npm run test:stack`.
- [ ] Reconcile legacy migration history on the staging project before any push (`docs/MIGRATION_VERSION_MAPPING.md`).
- [ ] Staging Supabase project (D4) and paid plan (D5) — later, by instruction.

## Not done by instruction

No production access, deployment, push, real invitations, outbound communications, purchases, authentication changes, or UI changes.

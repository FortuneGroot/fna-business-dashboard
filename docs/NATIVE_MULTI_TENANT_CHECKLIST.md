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
- [ ] Docker engine running — needs SVM Mode in UEFI, Virtual Machine Platform feature, restart.
- [x] Legacy migration versions made unique and ordered; mapping in `docs/MIGRATION_VERSION_MAPPING.md`; enforced by test.
- [ ] Remote migration history reconciled — cutover prerequisite (history unknown; no blind repair).
- [x] Real-stack suite written (`tests/supabase-stack/`, 12 tests) — **not yet run**.

## Checks

| Check | Environment | Status |
| --- | --- | --- |
| `npm test` | runner (unit 145, db 130, realpg 7, stack 12) | exit 2: three suites PASS, stack **BLOCKED** |
| `npm run test:db` | PGlite + Supabase shim | [x] PASS 130/130 |
| `npm run test:db:concurrency` | real local PostgreSQL 18.6, independent sessions | [x] PASS 7/7 |
| `tsc` (app and test files) | — | [x] PASS |
| `npm run build` | Next.js 15.5.25 | [x] PASS |
| Lint | — | not available (no script) |
| `npm run test:stack`: CLI `db reset` applies all migrations | real Supabase local stack | **BLOCKED** — Docker engine cannot start |
| GoTrue sign-up → profile; forged/expired/unsigned JWT; AAL1 vs TOTP AAL2 | real Supabase local stack | **BLOCKED** |
| RLS isolation, forged attribution, revoked membership, suspension, platform grants | real Supabase local stack | **BLOCKED** |
| Storage bucket + policies | real Supabase local stack | **BLOCKED** |
| Legacy tables closed to anon/authenticated over PostgREST | real Supabase local stack | **BLOCKED** |

## Remaining blockers / before P2

- [ ] Enable SVM Mode (ASUS UEFI → Advanced → CPU Configuration), enable Virtual Machine Platform (elevated `wsl --install --no-distribution`), restart, start Docker Desktop, run `npm run test:stack`.
- [ ] Reconcile legacy migration history on the staging project before any push (`docs/MIGRATION_VERSION_MAPPING.md`).
- [ ] Staging Supabase project (D4) and paid plan (D5) — later, by instruction.

## Not done by instruction

No production access, deployment, push, real invitations, outbound communications, purchases, authentication changes, or UI changes.

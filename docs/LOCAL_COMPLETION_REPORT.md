# Local completion report — native multi-tenant

Branch `feat/native-multi-tenant`. Final code `ab59783`; the commit that adds this report changes
documentation only. Local work only: nothing was pushed or deployed, no staging or production
project was touched, no invitation or message was sent, and no secret was printed.

Local completion is not independent review, staging validation or production approval. Those
remain separate gates (§6).

## 1. Fixes in this round

| Finding | Fix | Evidence | Commit |
| --- | --- | --- | --- |
| Codex P2: platform-admin grant/revoke and their audit rows were separate writes | M22: `platform_admin_grant` / `platform_admin_revoke` change the row and write the audit row in one transaction; the CLI calls them | PGlite: an audit failure rolls the change back; stack: CLI with a failing audit table changes nothing | `9317313` |
| Codex P2: two simultaneous revocations could remove the last two admins | M22: every change to `platform_admins` takes one advisory lock; a statement trigger refuses any delete, cascade or truncate that leaves zero admins | Real PostgreSQL, independent sessions: two-session races, 20-round burst, and a no-lock control that does reach zero; stack: two concurrent CLI revocations | `9317313` |
| Codex: `remove-mfa` partial failures | Start record before deleting (nothing deleted if it fails), per-factor errors caught, factors re-read, outcome recorded as complete, partial, none or unknown; exit 0 only when complete | Unit: injected factor, audit and re-read failures | `9317313` |
| Concurrent-booking 503 (intermittent) | Root cause: simultaneous inserts of one slot deadlocked in the exclusion check (40P01, unmapped, so 503). M23 takes a per-calendar lock before the check | Real PostgreSQL: 60 rounds × 8 simultaneous inserts and 20 × 8 reschedules give exactly one success and an overlap error (409) for every loser; the no-lock control reproduces the deadlocks (42 in 480 attempts before the fix) | `2a232d9` |
| Invitation-page stall (intermittent) | Not reproduced. The page now times out after 15 s and shows "Could not check this invitation" with Try again; a network or server failure is no longer reported as an invalid link | Stack: 25 fresh signed-out loads all settled (median 378 ms, max 540 ms), with pending-request and console diagnostics on any stall; an aborted preview recovers through Try again | `4740681` |
| Runner could hide a deleted test file behind tests added elsewhere | Minimum file counts for directory-listed suites | Unit regression in `tests/run-tests.test.ts` | `ab59783` |
| Earlier in this program | Permission-overrides editor, business hours, logo, full stage lists; scale guard | `tests/acceptance/product.test.ts`, scale suite | `7bf31c6`, `813367e` |

## 2. Requirement mapping

- Every endpoint in the spec's API table exists under `src/app/api`. Every handler is behind `nativeApi` (a named workspace permission), `platformApi` (platform-admin row + AAL2 session, with a fresh session check for sensitive actions), `readApi` (a named permission), or its own explicit check (auth routes, the public invitation preview, platform logo). Team changes add a second check for the specific `team.*` permission, and the database functions enforce authority and the last-owner rule independently.
- `docs/NATIVE_MULTI_TENANT_CHECKLIST.md`: every local item is ticked with its evidence. The unticked items are staging, cutover and T6/M15 gates.
- Migration manifest: `docs/STAGING_CUTOVER_CHECKLIST.md` §5 — two legacy files, M1–M14, M16–M23, never M15. A PGlite test fails if the table and `supabase/migrations/` disagree. Rollback: `supabase/rollback/20261101_native_multi_tenant.down.sql` (covers through M23).

## 3. Results by environment (final code)

| Check | Environment | Result |
| --- | --- | --- |
| Typecheck / build | Next.js 15.5.25 | PASS / PASS |
| Unit | Node 24.20.0 | PASS 258/258 |
| Database | PGlite + Supabase shim | PASS 232/232 (13 files) |
| Concurrency | Real local PostgreSQL 18.6, independent sessions | PASS 38/38 (3 files) |
| Supabase stack | Disposable real local Supabase + built app + Chromium | PASS 70/70 (on `4740681`; later commits touch only the runner and docs) |
| Acceptance | Fresh disposable stacks + built app + Chromium, two synthetic businesses, owner/admin/employee/platform roles | PASS 38/38 |
| UI-2 visual | Disposable stack + Chromium | 20/20 routes, sidebar 0.00% (on `813367e`; only the invitation page changed since, covered by the stack suite) |
| Bundle scan / secret scan | 113 client files / 27 changed files | Clean (one synthetic `sb_secret_abc` test value) |
| Staging, production | — | NOT RUN (no staging project; out of scope) |

Suites that share Docker ports or the build directory were run one at a time. No failures, cancellations or timeouts in the final runs. All disposable containers, volumes and test servers were removed.

## 4. Unresolved items

- **Invitation-page stall**: seen once, never reproduced since; now bounded by a timeout and retry. Reported as unresolved, not fixed.
- **D-A (decision)**: a platform admin who has used support access recorded in a workspace audit log cannot be revoked (the audit row references their grant). The attempt fails and changes nothing. Options: keep grants after removal, or deactivate admins instead of deleting them. Either is a schema change.
- **MFA recovery policy (decision)**: who may run `remove-mfa` and how identity is confirmed.
- **Hardening suggestion for the reviewer**: `private.is_platform_admin()` honours the session setting `app.platform_allow_aal1`. Not exploitable through PostgREST and never set in the repository, but removing it would close the path for good.

## 5. Readiness

- Ready for **independent final review** of the branch (Codex's review of the M22 work is still pending).
- Ready for a **staging rehearsal** once a staging project exists: `docs/STAGING_CUTOVER_CHECKLIST.md` §1, with handoff details in `docs/RELEASE_HANDOFF.md` (environment-variable names, bootstrap, backup/restore, rollback).
- **Not** production-ready until staging passes and George approves.

## 6. What George needs to do, in order

1. Have the branch reviewed independently (include M22, M23 and the invitation page).
2. Decide D-A and the MFA-recovery policy (two short decisions; nothing else is waiting on code).
3. Create the staging Supabase project and run `docs/STAGING_CUTOVER_CHECKLIST.md` §1 (manifest through M23, bootstrap yourself, MFA, backup/restore and rollback rehearsal, UI-2, bundle scan), then sign off.
4. Before production: paid plan, verified backup, your explicit approval, then checklist §2.

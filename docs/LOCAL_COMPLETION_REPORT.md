# Local completion report — native multi-tenant

Branch `feat/native-multi-tenant`. Final code `e18d829` after review round 3 (§8), which reviewed
`1f792df`; the commit that updates this report changes documentation only. Local work only: nothing was pushed or deployed, no staging or production
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
- Migration manifest: `docs/STAGING_CUTOVER_CHECKLIST.md` §5 — two legacy files, M1–M14, M16–M26, never M15. A PGlite test fails if the table and `supabase/migrations/` disagree. Rollback: `supabase/rollback/20261101_native_multi_tenant.down.sql` (covers through M26).

## 3. Results by environment (code `592d171`; acceptance on `e18d829`, which changes one test; each suite run on its own)

| Check | Environment | Result |
| --- | --- | --- |
| Typecheck / build | Next.js 15.5.25 | PASS / PASS |
| Unit | Node 24.20.0 | PASS 276/276 |
| Database | PGlite + Supabase shim | PASS 250/250 (16 files) |
| Concurrency | Real local PostgreSQL 18.6, independent sessions | PASS 64/64 (4 files) |
| Supabase stack | Disposable real local Supabase (M1–M14, M16–M26) + built app + Chromium | PASS 71/71 |
| Acceptance | Fresh disposable stacks + built app + Chromium, two synthetic businesses, owner/admin/employee/platform roles | PASS 39/39 |
| UI-2 visual | Disposable stack + Chromium | 20/20 routes, sidebar 0.00% (on `813367e`; later UI changes covered by acceptance, not re-measured) |
| Bundle scan / secret scan | 112 client chunks / diff since `1f792df` | Clean |
| Staging, production | — | NOT RUN (no staging project; out of scope) |

Suites that share Docker ports or the build directory were run one at a time. The first final acceptance run on `592d171` failed one test (38/39): the new sign-out-failure check deadlocked on its own alert (test bug, fixed in `e18d829`); the rerun passed 39/39. An earlier stack run found the provisioning race fixed in `75a531c`. All disposable containers, volumes and test servers were removed.

## 4. Unresolved items

- **Invitation-page stall**: seen once, never reproduced since; now bounded by a timeout and retry. Reported as unresolved, not fixed.
- **D-A resolved in M26**: revoking a platform admin with support history ends their grants and keeps grant, note, message and audit attribution; deleting such a person's auth account is refused (ban it instead; checklist §1).
- **MFA recovery policy (decision)**: who may run `remove-mfa` and how identity is confirmed.
- **Resolved in M26**: `private.is_platform_admin()` no longer honours the session setting `app.platform_allow_aal1`; platform authority needs an AAL2, live session with no override (tested in `tests/db/integrity-round3.test.ts`).

## 5. Readiness

- Ready for **independent final review** of the branch (Codex's review of the M22 work is still pending).
- Ready for a **staging rehearsal** once a staging project exists: `docs/STAGING_CUTOVER_CHECKLIST.md` §1, with handoff details in `docs/RELEASE_HANDOFF.md` (environment-variable names, bootstrap, backup/restore, rollback).
- **Not** production-ready until staging passes and George approves.

## 6. What George needs to do, in order

1. Have the branch reviewed independently (include M22–M26, the invitation page, the logo redesign, and the §7 and §8 fixes).
2. Decide the MFA-recovery policy (nothing else is waiting on code).
3. Create the staging Supabase project and run `docs/STAGING_CUTOVER_CHECKLIST.md` §1 (manifest through M26, bootstrap yourself, MFA, backup/restore and rollback rehearsal, UI-2, bundle scan), then sign off.
4. Before production: paid plan, verified backup, your explicit approval, then checklist §2.

## 7. Final bug-finding pass (reviewed `2500c80`, final `012a024`)

Method: a coverage matrix from the acceptance and stack test titles (journeys 1–16, hardening
packets, product, scale, backup/restore), three independent read-only reviews (database, client UI,
API), then a reproduction and a failing regression test for every confirmed defect before the fix.
Browser journeys use two synthetic businesses and owner, admin, employee and platform identities,
with allowed and denied paths.

| Severity | Defect and reproduction | Root cause | Fix | Regression evidence | Commit |
| --- | --- | --- | --- | --- | --- |
| High | An admin demoted to employee (or removed) still had open invitations, which could later be accepted as owner/admin | Invitations were checked only against the inviter's authority when created | M24: removal and role changes revoke the person's invitations that their new role no longer allows, with an audit row each | PGlite `invitation-authority` (3 tests, fail without M24); stack suite with M24 applied | `1508fa4` |
| High | Settings left open in tab A, business switched in tab B, logo uploaded in tab A: the logo was written to tab B's business and the control could stay disabled | The upload used a raw `fetch` without the workspace pin header | Upload through `api()` (keeps the file's content type and adds the pin) | Unit: `api()` upload headers; browser: refusal shown, control usable, no object in either business | `012a024` |
| Medium | Booking or moving an appointment onto an inactive calendar succeeded; appointments of any length were accepted | No database rule; the API checked only on some paths | M25 trigger refuses both, mapped to field errors (400) | PGlite `appointment-rules` (2 tests, fail without M25) | `fd2c2b3` |
| Medium | Create calendar, availability save fails, Try again: a second calendar was created; for a first calendar the error disappeared | Retry posted again; the error path refreshed the page, which swaps the layout and unmounted the dialog | Retry updates the created calendar; refresh happens on close | Browser: exactly one calendar, both availability saves to it, error stays visible | `012a024` |
| Medium | Editing or moving a card loaded by "Show more" left the old row; a stage whose cards were all hidden said "No opportunities yet" | The extra list never reloaded; the empty check ignored the stage count | Reload the list after edits, reset it when the top eight change, check the count | Browser: moved deal leaves, eleven remain, no duplicates, rename shows | `012a024` |
| Medium | Sign out with the server unreachable went to /login while the session stayed valid | The logout response was ignored | Report the failure and stay | Reviewed; existing logout journeys pass | `012a024` |
| Low | Search for `jo_n` matched `joxn` | `_` passed through to `ilike` as a wildcard | Strip it with other punctuation | Unit `searchWords` | `fd2c2b3` |
| Low | Reports with only "from" in the future were refused as backwards | The range check compared against a missing "to" | Compare with "to" or now | Unit report query | `fd2c2b3` |
| Low | A stale tab of an employee was told "no permission" instead of "you switched business" | Role denials were evaluated before the pin | Pin check first | Unit (fails without the fix) | `012a024` |
| Low | Rapid "Show more" or thread clicks could duplicate or misorder rows; task times lacked the UTC label shown elsewhere | No in-flight guard or latest-request check | Guards and labels | Reviewed; suites pass | `012a024` |

Not reproduced or not changed:

- **Invitation-page stall:** still not reproduced (25 instrumented loads per stack run). The page is bounded by the timeout and Try again state.
- **Booking 503:** fixed in Goal 1 (M23) and re-verified on real PostgreSQL in this pass.
- **Unconfirmed reviewer notes** (listed in `docs/RELEASE_HANDOFF.md` §5) were left for the independent review rather than changed without a reproduction.
- **Coverage gaps:** browser offline mode is simulated with aborted requests rather than a true offline toggle; back/forward is covered in one journey.

## 8. Review round 3 (reviewed `1f792df`, final `e18d829`)

The reviewers' findings came from static inspection; each was checked against `1f792df` before any change. "Reproduced" means a test failed on the old code.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| A. Invitations outliving issuer authority | Member removal and demotion were already protected (M24; the races passed before M26). Grant-issued and bootstrap invitations were confirmed and fixed in M26 (issuer authority checked under lock at acceptance; preview reports revoked) | Real PostgreSQL `tests/db-real/integrity.test.ts`: owner removed, admin demoted, revoked invitation, grant revoked, bootstrap lapse and recovery, acceptance vs removal/demotion/grant revocation in both orders |
| B. Platform-admin removal blocked by grant FK | Reproduced (23503) and fixed in M26: grants ended and audited, attribution kept, FK on `auth.users`, last-admin lock kept | Real PostgreSQL: read grant; write grant with note and message; already-ended grants untouched; last admin still protected |
| C. Stale-tab logo | Fixed earlier (`012a024`); remaining raw fetches (support, legacy inbox) now send the pin and explain a switch | Acceptance stale-tab test (browser); support/inbox by inspection |
| D. Inactive calendars | Race reproduced and fixed (calendar share-locked); create/reschedule/re-book refused, cancel and history allowed | Real PostgreSQL deactivation-first and booking-first races |
| E. 24-hour limit | Already protected by M25 on the stored row; regression tests added | Two-session edits, exactly 24 h, +1 s, existing longer row |
| F. Logo PUT/PUT, PUT/DELETE | Redesigned: unique object per upload, `set_workspace_logo` swap under row lock, previous removed after; platform writes recorded | Unit (fake), stack (concurrent HTTP, missing object, unrecorded upload), acceptance |
| G–P | Fixed earlier (`012a024`, `fd2c2b3`); tests added this round for I (stage older than newest 500), J (zones and day boundaries), K (`_`, `%`, punctuation), L (range defaults and boundaries), P (logout failure in a browser) | `tests/p8-integrity.test.ts`, acceptance scale and product |
| Provisioning race (found this round) | Reproduced (64 of 150 simultaneous calls) and fixed with a per-key advisory lock | Real PostgreSQL burst test |

Unconfirmed concerns: platform `hasLogo`/`logo_path` fixed; deleted-contact names fixed, live bookings kept by design (product decision); session-expiry and serialization mapping fixed; upload buffering fixed; lost acceptance response fixed (idempotent retry, page guidance); contact-detail race fixed; stale-tab support/config fixed; calendar card order fixed; legacy inbox empty state fixed; audit TRUNCATE fixed; `app.platform_allow_aal1` removed; dead sessions no longer read workspaces or profile (Realtime disabled, untested); removed-member profiles visible by design (REL-5); email ownership: new accounts prove it by token possession, signed-in acceptance now needs a confirmed email.
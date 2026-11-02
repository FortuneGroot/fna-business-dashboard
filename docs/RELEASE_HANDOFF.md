# Native multi-tenant release handoff

Local work plus the authorized staging validation and read-only production discovery. No production
write, push, deployment, invitation, or outbound message was made. Status vocabulary:

| Stage | Status |
| --- | --- |
| Local implementation | **Complete** for every locally implementable requirement in the spec (see §6 for the narrow items that are decisions, not code). |
| Local validation | Recovery follow-up validated: unit 287/287, PGlite 250/250, local recovery stack 10/10, strict types and build pass (§5). |
| Staging validation | Earlier baseline plus strengthened Gate B rehearsal **6/6 passed** on the corrected recovery code; no production changes. |
| Production release | **Pending** — George's decisions D1–D6, then three separate approvals: A1 backup and preflight, A2 database changes, A3 application cutover (the merge to `release` is the production deployment): `docs/PRODUCTION_RELEASE_PLAN.md` §9–§10. A paid plan is optional (D3). |

Local tests passing is not production readiness. The gates in `docs/PRODUCTION_RELEASE_PLAN.md` are.

## 1. Environment variable names

Values are never stored in the repository. Set by name in the hosting provider.

| Name | Used by | Notes |
| --- | --- | --- |
| `AUTH_PROVIDER` | app | `legacy` (default) or `supabase`. Any other value fails closed. |
| `SUPABASE_URL` | app, CLI | Project origin only. |
| `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) | app (server) | The browser never talks to Supabase except to load signed logo URLs. |
| `SUPABASE_SERVICE_ROLE_KEY` | app server only (`src/lib/supabase/admin.ts`), operator CLI | Never in the browser bundle (scanned). |
| `APP_ORIGIN` | app | Pins invite-link origin in deployed environments. |
| `AUTH_SECRET`, `AUTH_OWNER_*`, `AUTH_ADMIN_*`, `AUTH_CLIENT_*`, `AUTH_FAIL_CLOSED`, `AUTH_DEV_OPEN`, `AUTH_ALLOW_MEMORY_SESSIONS` | legacy mode only | Keep until T6 so `AUTH_PROVIDER=legacy` remains a rollback. |
| `GHL_LOCATION_ID` | legacy snapshot only | Not used in native mode. |
| `VERCEL_ENV`, `NODE_ENV` | set by the platform, not by hand | Legacy auth fails closed in deployed environments; secure cookies in production; the stack and acceptance harnesses refuse to run when `VERCEL_ENV` is set. |

## 2. Local cutover rehearsal (what the suites do, and how to repeat it by hand)

1. `node scripts/run-tests.mjs --suite stack` creates a disposable Supabase project copy (random `fna-disposable-*` id, ports +1000), applies every migration with the CLI, and destroys only its own containers and volumes.
2. Platform admin: sign up, then `npx tsx scripts/bootstrap-platform-admin.ts grant --email <e> --env local` (env `SUPABASE_URL` = the local API origin, `SUPABASE_SERVICE_ROLE_KEY` = the local key from `supabase status`). Enrol MFA at `/platform/mfa`.
3. Provision a workspace from the platform console; open the owner link (shown once) and accept it.
4. Set `AUTH_PROVIDER=supabase` for `next start`; the acceptance suite (`--suite acceptance`) runs every journey in §5 against such a stack with a real browser.

## 3. Migrations, history, backup, restore, rollback

- Required manifest: `docs/STAGING_CUTOVER_CHECKLIST.md` §5 — the two legacy files, M1–M14, M16–M27. **Never M15** (destructive legacy drop; not written).
- History reconciliation (renamed legacy versions): `docs/MIGRATION_VERSION_MAPPING.md`.
- Backup and restore: `docs/BACKUP_RESTORE_REHEARSAL.md`. The hosted explicit export (rehearsed on staging) restores Auth users with password hashes and MFA factors; sessions do not survive, and integration secrets need the same application key. The earlier local rehearsal used a reduced export without passwords or MFA factors.
- Rollback, application: set `AUTH_PROVIDER=legacy` and redeploy the previous build (spec §11). Legacy credentials stay in place until T6.
- Rollback, database (local/staging only): `supabase/rollback/20261101_native_multi_tenant.down.sql`. It resets the M21 PostgREST pre-request setting, drops native objects, and leaves legacy tables and data untouched; M14's legacy lockdown is intentionally not reverted. On hosted Supabase, delete the `workspace-assets` bucket through the Storage API first (hosted Storage refuses direct deletes); the full staging procedure is in `docs/STAGING_CUTOVER_CHECKLIST.md` §1.
- M23 note: a per-calendar lock trigger on `public.appointments`. Simultaneous bookings of one slot previously could deadlock (PostgreSQL 40P01, shown to users as a 503); now exactly one succeeds and the others get the overlap error (409). Rollback drops the trigger and its function.
- M24 note: when a member is removed or their role no longer allows the role they invited, their open invitations are revoked (each audited as `invitation.revoked`). Previously a demoted or removed admin's invitation could still be accepted. Rollback restores the M11 functions.
- M25 note: a trigger on `public.appointments` refuses new or moved bookings on an inactive calendar and appointments longer than 24 hours (shown as field errors, 400). Existing appointments on a calendar that is later deactivated are untouched. Rollback drops the trigger and its function.
- M21 note: after `db push`, confirm `pgrst.db_pre_request=public.check_request_session` on role `authenticator` (checklist §1). The migration sets it with `alter role authenticator` (the pattern Supabase documents for pre-request checks); if a hosted project refused that statement the migration would fail visibly — stop and report it rather than editing the migration.

## 4. Operators

| Task | How |
| --- | --- |
| Make someone a platform admin | `bootstrap-platform-admin.ts grant --email <e> --env <local\|staging\|production>`; they enrol MFA at `/platform/mfa`. |
| Remove a platform admin | `… revoke --email <e> --env … --reason "<why>"`; the database refuses to remove the last admin (exit 4), even when two operators act at once (M22). Grant and revoke commit with their audit row or not at all. Revoking ends the admin's open support grants (audited) and keeps their history attributed (M26). |
| Lost authenticator (MFA recovery) | Confirm identity per plan §7, then `… remove-mfa --email <e> --env … --reason "<ticket>"`. Save the printed operation UUID. First write a start record, confirm session termination, delete original factors, reread **all** factors and record the outcome. Exit 0 means confirmed termination and empty final factor list with recorded completion, even when initially no factors exist. Exit 5 means uncertainty or remaining/concurrent factors; no factor is deleted without confirmed termination. Exit 6 means factors were removed but completion auditing could not be confirmed. Resume with the same email/reason and `--operation-id <UUID>`; retries terminate sessions again and complete the same audit operation. Newly enrolled factors are preserved; review before a new operation. Reset the password if compromised; recovery does not block new sign-ins. No recovery codes. |
| Sign someone out everywhere | `… end-sessions --email <e> --env … --reason "<why>"` (stolen laptop, ex-staff). MFA and password unchanged; audited. |
| List platform admins | `… list --env …` (read-only). |
| End someone's access now | Remove the member (Settings → Team) or end their session; both apply on the next request. Logout is immediate (M21). |
| Support access to a business | Platform console → workspace → open read or write access with a reason and duration; every action is audited; it ends at expiry or when ended. |

Non-local runs of the CLI need `https`, an interactive terminal, and the typed phrase it prints. Keys come from the environment only.

## 5. Results by environment (earlier committed baseline)

Earlier code `bcd2b0b` (branch `feat/native-multi-tenant`). Every suite below ran on that code, one at a time. The local recovery follow-up after review of `c5762bc` changes code/tests as well as docs; this table is historical and does not validate those changes. Record follow-up results separately, and pin the reviewed candidate before release.

| Check | Environment | Result |
| --- | --- | --- |
| Typecheck / build | Next.js 15.5.25 | PASS / PASS |
| Unit | Node 24.20.0 | PASS 278/278 |
| Database (PGlite) | PGlite + shim | PASS 250/250 (16 files) |
| Concurrency | Real local PostgreSQL 18.6 | PASS 64/64 (4 files; M23 booking races and no-lock control, M26 invitation/admin/booking/provisioning races) |
| Supabase stack | Real local Supabase (disposable, all migrations except M15) + built app + Chromium | PASS 72/72 (includes M27 device-loss recovery: old access and refresh tokens refused; only the service role can end sessions) |
| Acceptance | Fresh disposable stacks + built app + Chromium | PASS 39/39 |
| UI-2 visual | disposable stack + Chromium | 20/20 routes 200, sidebar 0.00% (on `813367e`; later UI changes are covered by the acceptance suite, not re-measured) |
| Secret scan (changed files) | — | clean |
| Staging | `fna-staging` (Free plan, same organization and region as production) + locally built app | PASS: rehearsal 15/15 (twice), rollback (three runs), UI-2 (hosted equals local), hosted scale 5/5, explicit backup and restore 5/5; details in `docs/STAGING_CUTOVER_CHECKLIST.md` §1 |
| Production | — | Read-only preflight only (identities, schema, history, grants, aggregate counts, Vercel names); no writes. Findings, gates and decisions in `docs/PRODUCTION_RELEASE_PLAN.md` |

History: before M27 (`e18d829`, re-run after `359562a`) the same suites passed with unit 276/276 and stack 71/71, the browser bundle scan (113 client files) was clean, and UI-2 local was 20/20. Earlier rounds are in spec §24. M27 changed no client code. Hosted staging (2026-11-02, same code): M27 applied, and the MFA-recovery rehearsal `tests/staging/mfa-recovery.test.ts` passed 4/4 (plan §7).

Journeys covered with real browsers and denial paths: first owner setup and onboarding; login, logout (including replay of the old cookie and token, refresh, and a second tab); workspace selection and switching across two businesses; invitations, roles, permission overrides, ownership safeguards; CRM, pipeline, calendars, availability, appointments, tasks, inbox; settings, logo, integration status; platform MFA, provisioning, suspension, support grants with expiry and revocation; audited platform Storage; cross-business access refused.

### Local follow-up after independent review of `c5762bc` (2026-11-02)

This follow-up is based on `c5762bc`; the implementation commit containing this section is the candidate to review and pin, not an approved production release.
All seven findings are addressed locally: truthful uncertain session outcomes, operation-ID recovery
retry even with no factors, concurrent-factor detection, a complete write-freeze procedure,
stronger rehearsal assertions, explicit normal/early-M14 commands and consistent backup options.
No migration SQL changed. The initial local-only round made no hosted connections. George then authorized takeover: the strengthened synthetic staging rehearsal passed 6/6. No production changes, push or deployment occurred. The final candidate must be reviewed and pinned before release.

Local validation used an isolated copy without credential files. The tracked `.env.example` template was added for the final full unit run. Staging credentials were loaded privately only for the separately guarded hosted rehearsal:

- Targeted CLI/rejection-assertion unit tests: **24/24 PASS** (includes partial deletion, unknown
  reread, lost response, missing completion audit, zero factors and concurrent factors).
- Full unit suite: **287/287 PASS**. The prior isolated run had 286/287 passes because the tracked example template was absent; after takeover authorization the template was copied and the unchanged check passed. No assertion was skipped or weakened. Sandbox loopback failures were resolved by running outside the sandbox.
- PGlite + shim: **250/250 PASS**.
- Disposable local Supabase recovery integration: **10/10 PASS**, real Auth/PostgREST and CLI
  migrations. Initial custom-runner setup timed out at 60 seconds; rerun used the integration
  timeout. A stricter helper initially rejected raw GoTrue numeric `code` responses; it now checks
  the string `error_code`, with an added regression. The final integration run passed all ten.
- Strict application and test TypeScript checks: **PASS**. Production build without environment
  files: **PASS**. Diff whitespace check: **PASS**.
- Strengthened hosted staging MFA rehearsal: **6/6 PASS**. Ordinary-role denial, precise rejection codes, exact counts, full-row fingerprints, partial failure, re-enrolment, standalone termination and cleanup passed. Synthetic accounts removed; zero workspaces remained.
- Full real-PostgreSQL concurrency and complete stack/acceptance/browser suites: **not rerun in this follow-up**; no application or migration SQL changed. Earlier results are historical.

Next gate: review and pin the corrected commit, resolve the business/data/backup decisions, then give the separate A1/A2/A3 production approvals. Gate B technical rehearsal passed; passing tests alone do not establish security or authorize production release.

### Open findings

- **Invitation-page stall (intermittent, not reproduced).** Once, in an earlier stack run, the signed-out invitation page sat on "Checking your invitation…" for 20 s. A 25-load reproduction with request and console diagnostics now runs in the stack suite and settled every time (median 378 ms, max 540 ms). The page can no longer wait forever: requests time out after 15 s and show "Could not check this invitation" with Try again, and a network or server failure is no longer reported as an invalid link.
- **Booking 503 (fixed, M23).** Root cause: deadlocks between simultaneous inserts of the same slot. Reproduced on real PostgreSQL (42 deadlocks in 480 attempts before; 0 after).
- **Resolved in M26.** `private.is_platform_admin()` no longer accepts AAL1 under the session setting `app.platform_allow_aal1`; the branch is removed, so no path (including raw SQL as a user role) bypasses MFA for platform authority.
- **D-A resolved in M26.** Removing a platform admin who used support access no longer fails on the grant foreign key: `platform_admin_revoke` ends their open grants (audited per workspace) and keeps every grant, note, message and audit row attributed; the grant FK now references `auth.users`. Deleting that person's auth account is refused instead (ban it; see the checklist).
- **Review round 3 (reviewed `1f792df`, fixed in `47f8285`, `75a531c`, `592d171`).** Reproduced before fixing where executable (12 real-PostgreSQL and 12 PGlite tests failed without M26): invitations surviving the loss of a platform grant or of bootstrap admin status; acceptance without a confirmed email; a lost acceptance response leaving a retry refused; platform-admin removal blocked by grant history; bookings racing calendar deactivation; logo replace/delete races across separate requests and `logo_path` not following platform writes; unbounded upload buffering; TRUNCATE of audit tables; the AAL1 setting; dead sessions still reading their workspaces and profile; deleted contacts' names; session-expiry and serialization errors shown as 503; stale contact detail; stale-tab support and legacy inbox reads; calendar card order; and simultaneous provisioning of one key failing with 409 (found by the stack suite, 64 of 150 calls on real PostgreSQL). Dispositions of every finding: `docs/LOCAL_COMPLETION_REPORT.md` §8.
- **Final bug-finding pass (reviewed `2500c80`, fixed in `1508fa4`, `fd2c2b3`, `012a024`).** Fixed, each with a regression test that fails without the fix: invitations outliving their inviter's authority (M24, high); a logo upload from a stale tab writing to the newly active business (high); bookings on an inactive calendar and unbounded appointment length (M25, medium); a calendar retry creating a duplicate, and its error vanishing for a first calendar (medium); board edits after "Show more" leaving stale rows, and a stage with only hidden cards shown as empty (medium); logout reporting success when the request failed (medium); search treating `_` as a wildcard, and report dates with only "from" refused as backwards (low); stale tabs refused as "no permission" rather than "switched business" (low); overlapping audit, inbox and platform list requests, and task times without a UTC label (low). Details in `docs/LOCAL_COMPLETION_REPORT.md` §7.
- **Still open by design (for the independent review):** removed members' profile names stay visible to former colleagues for historical attribution (spec REL-5); soft-deleting a contact leaves their future appointments booked (staff cancel explicitly; product decision); an upload can still be refused with "no permission" if a switch lands mid-request (nothing is written); Realtime is disabled, so its session revocation is untested.

## 6. Remaining actions (George / external / staging / production only)

The consolidated, current list is `docs/PRODUCTION_RELEASE_PLAN.md` §9–§10 (decisions D1–D6, then approvals A1 backup and preflight, A2 database changes, A3 application cutover). That list supersedes the approvals P1–P8 of the previous plan. The read-only production preflight is done (plan §1–§5). Items 1 and 6 below are done on staging, as is the hosted MFA-recovery rehearsal. Items 2, 3, 4 and 5 are now D5, D3, plan §1 and D2. The original list is kept for reference:

1. Create the staging Supabase project (D4) and record its ref outside the repository.
2. Decide the MFA-recovery policy: who may run `remove-mfa` and how identity is confirmed; optionally keep a second platform admin (proposal in the plan, §7).
3. Paid Supabase plan before production (now optional, plan D3).
4. Confirm whether any live deployment still sets `CLIENT_CONFIG_PATH` or `GHL_PIPELINE_ID`.
5. Disable the GHL webhook before promoting a P7 build (or keep `release` @ `9c189f8`).
6. On staging: reconcile migration history, push the manifest, confirm M21's pre-request setting, bootstrap George, run the rehearsal, backup/restore and rollback tests, UI-2, bundle scan; sign off.
7. Production: George's explicit approval, verified backup, the same manifest, bootstrap, `AUTH_PROVIDER=supabase`, smoke, rollback ready.
8. After 14 stable days: T6 legacy removal, then write and apply M15 with a verified backup (separate approval).

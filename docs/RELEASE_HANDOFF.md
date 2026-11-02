# Native multi-tenant release handoff

Prepared from local work only. No staging or production project, deployment, push, invitation, or
outbound message was used. Status vocabulary:

| Stage | Status |
| --- | --- |
| Local implementation | **Complete** for every locally implementable requirement in the spec (see §6 for the narrow items that are decisions, not code). |
| Local validation | **Done** on the final commit — see §5 for results by environment. |
| Staging validation | **Pending** — no staging project exists yet (decision D4). |
| Production release | **Pending** — requires George's approval, a paid plan (D5), and a passed staging rehearsal. |

Local tests passing is not production readiness. The staging rehearsal (`docs/STAGING_CUTOVER_CHECKLIST.md`) is the gate.

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
- Backup and restore: `docs/BACKUP_RESTORE_REHEARSAL.md` (local rehearsal and what a restore does not bring back: passwords, sessions, MFA factors, integration secrets).
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
| Remove a platform admin | `… revoke --email <e> --env … --reason "<why>"`; the database refuses to remove the last admin (exit 4), even when two operators act at once (M22). Grant and revoke commit with their audit row or not at all. Known limitation: an admin who has used support access that was recorded in a workspace audit log cannot be revoked yet (the audit row references the grant); the attempt fails and changes nothing — decision D-A below. |
| Lost authenticator (MFA recovery) | Confirm identity out of band (`docs/PRODUCTION_RELEASE_PLAN.md` §7), then `… remove-mfa --email <e> --env … --reason "<ticket>"`; the admin signs in and re-enrols. No recovery codes. It first ends every session of the account (M27; old access and refresh tokens stop working at once, audited), then deletes the factors. The password is unchanged: if it may be known too, also send a password reset. Writes a start record first (nothing is changed if that fails) and then the observed outcome. Exit 0 only when sessions ended and every factor is gone and recorded; 5 means sessions could not be ended (no factor deleted), some factors remain, or the outcome could not be confirmed (the message says which); 6 means removed but the completion record failed. Re-run `remove-mfa` after an incomplete result. |
| Sign someone out everywhere | `… end-sessions --email <e> --env … --reason "<why>"` (stolen laptop, ex-staff). MFA and password unchanged; audited. |
| List platform admins | `… list --env …` (read-only). |
| End someone's access now | Remove the member (Settings → Team) or end their session; both apply on the next request. Logout is immediate (M21). |
| Support access to a business | Platform console → workspace → open read or write access with a reason and duration; every action is audited; it ends at expiry or when ended. |

Non-local runs of the CLI need `https`, an interactive terminal, and the typed phrase it prints. Keys come from the environment only.

## 5. Results by environment (final commit)

Final code `e18d829` (branch `feat/native-multi-tenant`); application and database code are identical to `592d171`, and `e18d829` changes one acceptance test. Unit, database, concurrency and stack ran on `592d171`; acceptance ran on `e18d829`; one suite at a time. Earlier rounds are in spec §24.

| Check | Environment | Result |
| --- | --- | --- |
| Typecheck / build | Next.js 15.5.25 | PASS / PASS |
| Unit | Node 24.20.0 | PASS 276/276 |
| Database (PGlite) | PGlite + shim | PASS 250/250 (16 files) |
| Concurrency | Real local PostgreSQL 18.6 | PASS 64/64 (4 files; M23 booking races and no-lock control, M26 invitation/admin/booking/provisioning races) |
| Supabase stack | Real local Supabase (disposable, M1–M14 and M16–M26) + built app + Chromium | PASS 71/71 (72/72 with M27, below) |
| Acceptance | Fresh disposable stacks + built app + Chromium | PASS 39/39 |
| UI-2 visual | disposable stack + Chromium | 20/20 routes 200, sidebar 0.00% (on `813367e`; later UI changes are covered by the acceptance suite, not re-measured) |
| Bundle scan (112 client chunks) / secret scan (diff since `1f792df`) | — | clean |
| Staging | `fna-staging` (Free plan, same organization and region as production) + locally built app | PASS: rehearsal 15/15 (twice), rollback (three runs), UI-2 (hosted equals local), hosted scale 5/5, explicit backup and restore 5/5; details in `docs/STAGING_CUTOVER_CHECKLIST.md` §1 |
| Production | — | Read-only preflight only (identities, schema, history, grants, aggregate counts, Vercel names); no writes. Findings, gates and decisions in `docs/PRODUCTION_RELEASE_PLAN.md` |

Re-run after the hosted rollback fix (`359562a`), with no app or database code changed since, one suite at a time: typecheck PASS, build PASS, unit 276/276, database 250/250, concurrency 64/64, stack 71/71, acceptance 39/39, UI-2 local 20/20 (figures identical to the accepted run), bundle scan of 113 client files clean, secret scan of the changed files clean.

Release-preparation round (M27 MFA-recovery session revocation, `remove-mfa` ends sessions first, new `end-sessions`), one suite at a time on the final working tree: typecheck PASS, build PASS, unit 278/278, database 250/250, concurrency 64/64, stack 72/72 (new: device-loss recovery refuses old access and refresh tokens; only the service role can end sessions), acceptance 39/39; secret scan of the changed files clean. M27 is not on staging yet (plan §7, Gate B).

Journeys covered with real browsers and denial paths: first owner setup and onboarding; login, logout (including replay of the old cookie and token, refresh, and a second tab); workspace selection and switching across two businesses; invitations, roles, permission overrides, ownership safeguards; CRM, pipeline, calendars, availability, appointments, tasks, inbox; settings, logo, integration status; platform MFA, provisioning, suspension, support grants with expiry and revocation; audited platform Storage; cross-business access refused.

### Open findings

- **Invitation-page stall (intermittent, not reproduced).** Once, in an earlier stack run, the signed-out invitation page sat on "Checking your invitation…" for 20 s. A 25-load reproduction with request and console diagnostics now runs in the stack suite and settled every time (median 378 ms, max 540 ms). The page can no longer wait forever: requests time out after 15 s and show "Could not check this invitation" with Try again, and a network or server failure is no longer reported as an invalid link.
- **Booking 503 (fixed, M23).** Root cause: deadlocks between simultaneous inserts of the same slot. Reproduced on real PostgreSQL (42 deadlocks in 480 attempts before; 0 after).
- **Resolved in M26.** `private.is_platform_admin()` no longer accepts AAL1 under the session setting `app.platform_allow_aal1`; the branch is removed, so no path (including raw SQL as a user role) bypasses MFA for platform authority.
- **D-A resolved in M26.** Removing a platform admin who used support access no longer fails on the grant foreign key: `platform_admin_revoke` ends their open grants (audited per workspace) and keeps every grant, note, message and audit row attributed; the grant FK now references `auth.users`. Deleting that person's auth account is refused instead (ban it; see the checklist).
- **Review round 3 (reviewed `1f792df`, fixed in `47f8285`, `75a531c`, `592d171`).** Reproduced before fixing where executable (12 real-PostgreSQL and 12 PGlite tests failed without M26): invitations surviving the loss of a platform grant or of bootstrap admin status; acceptance without a confirmed email; a lost acceptance response leaving a retry refused; platform-admin removal blocked by grant history; bookings racing calendar deactivation; logo replace/delete races across separate requests and `logo_path` not following platform writes; unbounded upload buffering; TRUNCATE of audit tables; the AAL1 setting; dead sessions still reading their workspaces and profile; deleted contacts' names; session-expiry and serialization errors shown as 503; stale contact detail; stale-tab support and legacy inbox reads; calendar card order; and simultaneous provisioning of one key failing with 409 (found by the stack suite, 64 of 150 calls on real PostgreSQL). Dispositions of every finding: `docs/LOCAL_COMPLETION_REPORT.md` §8.
- **Final bug-finding pass (reviewed `2500c80`, fixed in `1508fa4`, `fd2c2b3`, `012a024`).** Fixed, each with a regression test that fails without the fix: invitations outliving their inviter's authority (M24, high); a logo upload from a stale tab writing to the newly active business (high); bookings on an inactive calendar and unbounded appointment length (M25, medium); a calendar retry creating a duplicate, and its error vanishing for a first calendar (medium); board edits after "Show more" leaving stale rows, and a stage with only hidden cards shown as empty (medium); logout reporting success when the request failed (medium); search treating `_` as a wildcard, and report dates with only "from" refused as backwards (low); stale tabs refused as "no permission" rather than "switched business" (low); overlapping audit, inbox and platform list requests, and task times without a UTC label (low). Details in `docs/LOCAL_COMPLETION_REPORT.md` §7.
- **Still open by design (for the independent review):** removed members' profile names stay visible to former colleagues for historical attribution (spec REL-5); soft-deleting a contact leaves their future appointments booked (staff cancel explicitly; product decision); an upload can still be refused with "no permission" if a switch lands mid-request (nothing is written); Realtime is disabled, so its session revocation is untested.

## 6. Remaining actions (George / external / staging / production only)

The consolidated, current list is `docs/PRODUCTION_RELEASE_PLAN.md` §9–§10 (decisions D1–D7, release gates A and B, and the separate cutover approval). That list supersedes the approvals P1–P8 of the previous plan. The read-only production preflight is done (plan §1–§5). Items 1 and 6 below are done on staging; items 2, 4 and 5 are now D5, plan §1 and D3. The original list is kept for reference:

1. Create the staging Supabase project (D4) and record its ref outside the repository.
2. Decide the MFA-recovery policy: who may run `remove-mfa` and how identity is confirmed; optionally keep a second platform admin (proposal in the plan, §7).
3. Paid Supabase plan before production (D5).
4. Confirm whether any live deployment still sets `CLIENT_CONFIG_PATH` or `GHL_PIPELINE_ID`.
5. Disable the GHL webhook before promoting a P7 build (or keep `release` @ `9c189f8`).
6. On staging: reconcile migration history, push the manifest, confirm M21's pre-request setting, bootstrap George, run the rehearsal, backup/restore and rollback tests, UI-2, bundle scan; sign off.
7. Production: George's explicit approval, verified backup, the same manifest, bootstrap, `AUTH_PROVIDER=supabase`, smoke, rollback ready.
8. After 14 stable days: T6 legacy removal, then write and apply M15 with a verified backup (separate approval).

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

- Required manifest: `docs/STAGING_CUTOVER_CHECKLIST.md` §5 — the two legacy files, M1–M14, M16–M23. **Never M15** (destructive legacy drop; not written).
- History reconciliation (renamed legacy versions): `docs/MIGRATION_VERSION_MAPPING.md`.
- Backup and restore: `docs/BACKUP_RESTORE_REHEARSAL.md` (local rehearsal and what a restore does not bring back: passwords, sessions, MFA factors, integration secrets).
- Rollback, application: set `AUTH_PROVIDER=legacy` and redeploy the previous build (spec §11). Legacy credentials stay in place until T6.
- Rollback, database (local/staging only): `supabase/rollback/20261101_native_multi_tenant.down.sql`. It resets the M21 PostgREST pre-request setting, drops native objects, and leaves legacy tables and data untouched; M14's legacy lockdown is intentionally not reverted.
- M23 note: a per-calendar lock trigger on `public.appointments`. Simultaneous bookings of one slot previously could deadlock (PostgreSQL 40P01, shown to users as a 503); now exactly one succeeds and the others get the overlap error (409). Rollback drops the trigger and its function.
- M21 note: after `db push`, confirm `pgrst.db_pre_request=public.check_request_session` on role `authenticator` (checklist §1). The migration sets it with `alter role authenticator` (the pattern Supabase documents for pre-request checks); if a hosted project refused that statement the migration would fail visibly — stop and report it rather than editing the migration.

## 4. Operators

| Task | How |
| --- | --- |
| Make someone a platform admin | `bootstrap-platform-admin.ts grant --email <e> --env <local\|staging\|production>`; they enrol MFA at `/platform/mfa`. |
| Remove a platform admin | `… revoke --email <e> --env … --reason "<why>"`; the database refuses to remove the last admin (exit 4), even when two operators act at once (M22). Grant and revoke commit with their audit row or not at all. Known limitation: an admin who has used support access that was recorded in a workspace audit log cannot be revoked yet (the audit row references the grant); the attempt fails and changes nothing — decision D-A below. |
| Lost authenticator (MFA recovery) | Confirm identity out of band, then `… remove-mfa --email <e> --env … --reason "<why>"`; the admin signs in and re-enrols. No recovery codes. Does not end sessions — if the device may be compromised, also revoke or reset the password. Writes a start record first (nothing is deleted if that fails) and then the observed outcome. Exit 0 only when every factor is gone and recorded; 5 means some factors remain or the outcome could not be confirmed (the message lists them); 6 means removed but the completion record failed. Re-run `remove-mfa` after an incomplete result. |
| List platform admins | `… list --env …` (read-only). |
| End someone's access now | Remove the member (Settings → Team) or end their session; both apply on the next request. Logout is immediate (M21). |
| Support access to a business | Platform console → workspace → open read or write access with a reason and duration; every action is audited; it ends at expiry or when ended. |

Non-local runs of the CLI need `https`, an interactive terminal, and the typed phrase it prints. Keys come from the environment only.

## 5. Results by environment (final commit)

Final code `ab59783` (branch `feat/native-multi-tenant`); later commits change documentation only. Earlier rounds are in spec §24.

| Check | Environment | Result |
| --- | --- | --- |
| Typecheck / build | Next.js 15.5.25 | PASS / PASS |
| Unit | Node 24.20.0 | PASS 258/258 |
| Database (PGlite) | PGlite + shim | PASS 232/232 (13 files) |
| Concurrency | Real local PostgreSQL 18.6 | PASS 38/38 (3 files; includes the M23 booking races and the no-lock control) |
| Supabase stack | Real local Supabase (disposable) + built app + Chromium | PASS 70/70 (run on `4740681`; later commits touch only the runner and docs) |
| Acceptance | Fresh disposable stacks + built app + Chromium | PASS 38/38 |
| UI-2 visual | disposable stack + Chromium | 20/20 routes 200, sidebar 0.00% (on `813367e`; only the invitation page changed since, covered by the stack suite) |
| Bundle scan (113 client files) / secret scan (27 changed files) | — | clean (one synthetic `sb_secret_abc` test value) |
| Staging | — | NOT RUN (no staging project) |
| Production | — | NOT RUN (out of scope) |

Journeys covered with real browsers and denial paths: first owner setup and onboarding; login, logout (including replay of the old cookie and token, refresh, and a second tab); workspace selection and switching across two businesses; invitations, roles, permission overrides, ownership safeguards; CRM, pipeline, calendars, availability, appointments, tasks, inbox; settings, logo, integration status; platform MFA, provisioning, suspension, support grants with expiry and revocation; audited platform Storage; cross-business access refused.

### Open findings

- **Invitation-page stall (intermittent, not reproduced).** Once, in an earlier stack run, the signed-out invitation page sat on "Checking your invitation…" for 20 s. A 25-load reproduction with request and console diagnostics now runs in the stack suite and settled every time (median 378 ms, max 540 ms). The page can no longer wait forever: requests time out after 15 s and show "Could not check this invitation" with Try again, and a network or server failure is no longer reported as an invalid link.
- **Booking 503 (fixed, M23).** Root cause: deadlocks between simultaneous inserts of the same slot. Reproduced on real PostgreSQL (42 deadlocks in 480 attempts before; 0 after).
- **Hardening suggestion for the independent review.** `private.is_platform_admin()` accepts AAL1 when the session setting `app.platform_allow_aal1 = 'on'`. Nothing in the repository sets it (a unit test forbids it) and clients reach the database only through PostgREST, which cannot set it, so it is not exploitable today; but any future path that gives a user role raw SQL would bypass MFA. Removing the branch is a schema change and was left for review.
- **D-A** (below) remains a decision.

## 6. Remaining actions (George / external / staging / production only)

1. Create the staging Supabase project (D4) and record its ref outside the repository.
2. Decide the MFA-recovery policy: who may run `remove-mfa` and how identity is confirmed; optionally keep a second platform admin.
   - D-A: how a platform admin who has used support access should be removed. Today the workspace audit log's reference to their grant blocks revocation. Options: keep grants (and their audit references) when an admin is removed, or mark the admin inactive instead of deleting the row. Either is a schema change, so it was left for this decision.
3. Paid Supabase plan before production (D5).
4. Confirm whether any live deployment still sets `CLIENT_CONFIG_PATH` or `GHL_PIPELINE_ID`.
5. Disable the GHL webhook before promoting a P7 build (or keep `release` @ `9c189f8`).
6. On staging: reconcile migration history, push the manifest, confirm M21's pre-request setting, bootstrap George, run the rehearsal, backup/restore and rollback tests, UI-2, bundle scan; sign off.
7. Production: George's explicit approval, verified backup, the same manifest, bootstrap, `AUTH_PROVIDER=supabase`, smoke, rollback ready.
8. After 14 stable days: T6 legacy removal, then write and apply M15 with a verified backup (separate approval).

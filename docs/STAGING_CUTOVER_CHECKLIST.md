# Staging rehearsal and production cutover checklist

Prepared from local evidence, then updated with the staging rehearsal of 2026-11-02 (§1).
This checklist records staging activity; the separately authorized read-only production preflight
is in the production release plan. **No production changes were made.** A box is ticked only where evidence is recorded.
Staging is the separate Supabase project from decision D4. Production steps require George's
explicit approval (spec §9.2 P9, §11).

## 0. Decisions that must be made first (open — not complete)

| Decision | Evidence so far (local) | Who | Status |
| --- | --- | --- | --- |
| **Logout replay.** Previously a copied session cookie kept working until its access token expired. | **Implemented locally (M21, spec §5.1):** access requires the token's Auth session row; logout ends reads, writes, and direct Data API use at once. Acceptance test 14 and the product rehearsal (two browser tabs) now observe **401** for replayed reads, writes, sensitive actions, and the raw token at PostgREST; the refresh token is revoked; other sessions continue. | George (acknowledge) | DONE locally — verify on staging (the PostgREST pre-request setting must be present after `db push`) |
| **Migration-history reconciliation.** The two legacy migrations were renamed from the shared version `20260917`; the remote history of any existing database is unknown. | `docs/MIGRATION_VERSION_MAPPING.md` lists the three possible findings and the exact `supabase migration repair` command for each. Nothing has been run against any remote database. | Operator, on staging first | OPEN |
| **MFA recovery.** No recovery codes, by design. | M27 and the earlier 4/4 rehearsal are on staging. Local follow-up adds operation reconciliation/resume, zero-factor termination and concurrent-factor detection; the strengthened six-test hosted rehearsal passed 6/6 (§1). | George / operator | Technical rehearsal passed 6/6; production recovery policy remains (plan D5); a second admin is optional |
| **Backup/recovery option** before production (plan D3). | Choose and verify the explicit $0 export/restore procedure or the paid option; a paid plan is optional, not a prerequisite. | George | OPEN |
| **Per-client configuration owner check.** Whether any live deployment still sets `CLIENT_CONFIG_PATH` or `GHL_PIPELINE_ID`. | P7 removed runtime use of both (spec §21.4); the legacy snapshot reads only the bundled default. Not verifiable locally. | Owner of the Vercel project | OPEN |
| **Platform-admin bootstrap.** | `scripts/bootstrap-platform-admin.ts` (A2) written: `grant`/`revoke`/`remove-mfa`/`list`, audited; `--env local` accepts only loopback URLs; `--env staging|production` needs https, an interactive terminal, and the typed phrase it shows. Unit tests plus a disposable-stack test; never run against a hosted project. | George / operator | DONE locally — first hosted use is T2 on staging |
| **P7 deploy ordering.** A P7 build has no `/api/webhooks/ghl`; a deployment that still receives GHL webhooks will get 404s. | Spec §21.4; `docs/VERCEL_RELEASE_POLICY.md`. | George | OPEN — disable the GHL webhook before promoting a P7 build, or keep the pre-P7 build (`release` @ `9c189f8`) |

## 1. Staging rehearsal (P8 / T2–T4)

Staging evidence, 2026-11-02 (George approved a $0 Free-plan project in the production project's organization and region; no production data, credentials, or settings were read or changed; nothing was deployed):

- Project created on the Free plan ($0/month, confirmed by the Supabase cost check), PostgreSQL 17. The ref is in the runbook only.
- History reconciliation: read-only inspection found no `supabase_migrations` history and no public tables, so the third finding applied ("tables absent"): `supabase db push` applied all 27 files; `supabase migration list` showed local and remote identical.
- Verified after push: M14 (all ten legacy tables closed to `anon`/`authenticated`), M21 (`pgrst.db_pre_request=public.check_request_session` on `authenticator`), RLS on every public table, no table in the `supabase_realtime` publication, `/auth/v1/settings` reports `disable_signup=true` and `mailer_autoconfirm=false`.
- T2: George's user added in the dashboard (email confirmed), `bootstrap-platform-admin.ts grant --env staging` run by George with the typed phrase, TOTP enrolled at `/platform/mfa`, session at AAL2.
- T4: `tests/staging/rehearsal.test.ts` (15 journeys: MFA, provisioning, invitations with public sign-up off, roles, records, overrides, isolation including the raw Data API with each user's JWT, malformed input, concurrency, pagination, support grants with clock expiry, suspension, removal, logout replay, audit isolation) passed 15/15 through the locally built app against staging, and 15/15 again after the rollback and re-apply. Client bundle scan of that build: no secret key value, no `sb_secret_`, no `SUPABASE_SERVICE_ROLE_KEY`.
- Rollback rehearsal: see the hosted procedure below. Run twice; legacy rows (synthetic markers) kept identical fingerprints, M14 stayed in force, George's account, password, and MFA factor were unchanged, and synthetic users were deleted afterwards.

Second staging round, 2026-11-02 (staging only, synthetic data, nothing deployed):

- **UI-2 on staging:** `tests/visual/ui2-visual-parity.ts --target staging --name "Fortune & Automations (synthetic)"`.
  - All 20 routes returned 200 through the locally built app against staging.
  - Compared with `docs/baseline/`, the sidebar differs by about 7.6% on every page. That is the longer synthetic name wrapping to three lines; the overall differences otherwise match the accepted local figures.
  - Hosted against local, same name and same build: 0.00% on 19 of 20 routes. Settings differs by 0.15%, which is test data only: owner name, email and timestamp.
  - The local run against `docs/baseline/` reproduced the accepted figures exactly: sidebar 0.00%, dashboard 6.71%, help 9.87%, settings 61.98%, onboarding 62.71%.
- **Hosted large data:** `tests/staging/scale.test.ts` passed 5/5, using the same seed as the local scale test (`tests/acceptance/scale-seed.ts`).
  - Contacts: 1,458 live contacts paged by 100 and by 37 across 400 tied timestamps, with search and tag filters and exact totals.
  - Pipeline: 1,250 opportunities, with stage and status filters, an exact board count beyond 1,000, and an older stage offering "Show 17 more".
  - Busy calendar: 1,100 bookings in a year, returned soonest-first as 500 marked truncated; the March view is complete with 106 bookings.
  - Statement counts stay flat as data grows (at most +4). Pages took 200–620 ms from this machine to `us-east-1`.
- **Hosted backup and restore:** `tests/staging/backup-restore.test.ts` passed 5/5. It used an explicit database export and Storage export, restored into a separate, empty, disposable environment (see `docs/BACKUP_RESTORE_REHEARSAL.md`). It found, and its procedure now fixes, two gaps in a plain `db dump` restore:
  - the six app policies and triggers on Supabase-owned tables are missing;
  - default privileges widen grants on restored objects.
- **Third rollback run** (cleanup after this round): the bucket emptied and deleted through the Storage API, the down script applied, 12 synthetic users deleted, the 24 versions repaired and re-pushed. George was restored as the only platform admin, with his password and MFA factor unchanged.
  - Read-only checks afterwards: M21 present, M14 closed, RLS on every public table, 0 Realtime tables, and history at 27 rows.
  - The only `security definer` functions `anon` may call are `peek_invitation` and `check_request_session`, both intended.
- **M27 and the hosted MFA-recovery rehearsal (2026-11-02, code `bcd2b0b`):**
  - The project identity was confirmed and the history read (27 rows, latest `20261101002500`).
  - The `db push --dry-run` listed only `20261101002600`, which was then pushed. History is now 28 rows.
  - `platform_end_user_sessions` is `security definer`, and only `service_role` may execute it.
  - `tests/staging/mfa-recovery.test.ts` passed 4/4; details in `docs/PRODUCTION_RELEASE_PLAN.md` §7. Its synthetic users were deleted. George's user, password hash, MFA factor, session and admin row were fingerprinted and unchanged.

**Post-review local follow-up:** the original 4/4 run used broad non-200 Auth checks and selected-field fingerprints; it is historical evidence, not proof of the strengthened assertions. Recovery code and the six-test rehearsal have since changed (operation reconciliation/retry, zero-factor recovery and concurrent-factor detection). Gate B technical validation is **complete: strengthened hosted run passed 6/6 on the corrected recovery code**, including exact rejection codes/counts, full-row fingerprints, denied M27 calls, standalone session termination and empty-workspace cleanup. The initial local-only round made no hosted changes. George subsequently authorized takeover; the strengthened staging test then passed all six checks, including cleanup, full-row fingerprints and ordinary-role denial. No production access or deployment occurred.

Hosted rollback procedure (staging only; the unchanged script failed on hosted Storage with `42501 Direct deletion from storage tables is not allowed`, and its transaction left everything untouched):

1. Empty and delete the `workspace-assets` bucket through the Storage API (`POST /storage/v1/bucket/workspace-assets/empty`, then `DELETE /storage/v1/bucket/workspace-assets`, service key). Emptying finishes in the background, so a delete issued immediately can answer 400; wait until `storage.objects` has no rows for the bucket, then retry. The script now refuses with a clear message if the bucket still exists on hosted Storage.
2. `STAGING_PROJECT_REF=… STAGING_DB_URL=… node scripts/staging-sql.mjs supabase/rollback/20261101_native_multi_tenant.down.sql` (refuses any other project and the production ref).
3. Optionally delete `@example.test` Auth users (possible only now: grant history no longer references them).
4. `supabase migration repair --status reverted` for the 25 native versions (M1–M13, M16–M27; M14 stays applied), then `supabase db push --include-all`. The versions are 14 digits: `20261101000100` … `20261101001300` and `20261101001500` … `20261101002600`, each step 100. Check every version against a file in `supabase/migrations/` before running the repair: a mistyped version is silently accepted and repairs nothing.
5. Restore platform admins with `platform_admin_grant` (audited) and recreate their `profiles` rows: re-applying M9 does not backfill profiles for Auth users created before it.

- [x] Create the separate staging Supabase project (D4). Record its project ref in the runbook, never in the repository.
- [x] Back up staging. The Free plan has no managed backups, so the explicit export was used (database dump plus Storage files; `docs/BACKUP_RESTORE_REHEARSAL.md`, hosted section). The rehearsal export was kept in the OS temp directory and deleted, because it holds password hashes and MFA secrets. No standing staging backup is kept.
- [x] Reconcile migration history per `docs/MIGRATION_VERSION_MAPPING.md` (read-only inspection first; record which of the three findings applied).
- [x] `supabase db push` the required manifest (§5) to staging; `supabase migration list` shows local and remote identical. M15 is not part of it.
- [x] Confirm M14: legacy `sync_*` and `auth_sessions` closed to `anon`/`authenticated` (stack test "legacy tables are closed…" is the local equivalent).
- [x] T2: create George's auth user (with public sign-up disabled: Supabase dashboard → Authentication → Add user, email confirmed), then `SUPABASE_URL=<staging origin> SUPABASE_SERVICE_ROLE_KEY=<staging key> npx tsx scripts/bootstrap-platform-admin.ts grant --email <george> --env staging` from an interactive terminal, type the confirmation phrase, and enrol MFA at `/platform/mfa` (D6). Confirm with `… list --env staging`. The key is read from the environment only; never paste it into a file or command history.
- [x] Confirm M21 on staging: `select rolconfig from pg_roles where rolname = 'authenticator'` includes `pgrst.db_pre_request=public.check_request_session`; after logging out, the old cookie gets 401.
- [ ] T3: provision the F&A workspace (`provisioning_key = 'fa-live'`); open the owner link (shown once, nothing is emailed) and accept it as George. (Not done: staging holds synthetic businesses only.)
- [x] Auth settings on staging: public sign-up disabled (`enable_signup = false`; invited accounts are created server-side from the invitation token, M26 requires a confirmed email for the signed-in acceptance path), email confirmation on, MFA (TOTP) enabled, Realtime not exposed for business tables. Record the settings screenshot in the runbook. Leaked-password protection is off (Supabase advisor); it is a Pro-plan setting, so decide it with D5.
- [ ] Account deletion: deleting an auth user who ever held a platform grant is refused by `platform_access_grants_admin_user_id_fkey` (M26 keeps grant history attributed). Remove platform authority with `bootstrap-platform-admin.ts revoke` (ends open grants, audited) and ban the auth user instead of deleting it; a GDPR erasure request needs a separate, reviewed procedure.
- [ ] Set staging app env by name only: `AUTH_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `APP_ORIGIN`. No `GHL_*` variables.
- [x] T4: run the acceptance suite's journeys against staging with synthetic businesses (`tests/staging/rehearsal.test.ts`, the allowlisted staging harness; the local harness still refuses non-local hosts).
- [x] UI-2 screenshot comparison against `docs/baseline/` on staging (second round above; hosted equals local).
- [x] Bundle scan of the staging build: no service-role key, no `SUPABASE_SERVICE_ROLE_KEY` value, no GHL token.
- [x] Rollback rehearsal on staging: run `supabase/rollback/20261101_native_multi_tenant.down.sql`, confirm legacy tables and data untouched, then re-apply (hosted procedure above).
- [x] Restore-from-backup test (required before T6/M15). Staging's explicit export was restored into a separate, empty, disposable environment and verified; passwords and MFA factors survive this procedure, while sessions do not. Limitation: the target was a local stack, not a second hosted project; the Free plan's two active projects are both in use. A hosted-target restore is an open decision in `docs/PRODUCTION_RELEASE_PLAN.md`.
- [x] Confirm the hosted API gateway still answers a busy calendar month and a full contacts page (`tests/staging/scale.test.ts`, second round above).
- [ ] George signs off on staging.

## 2. Production cutover (P9 / T5) — requires George's explicit approval

- [ ] Selected backup/recovery option approved and verified (plan D3); paid plan optional. Strengthened Gate B MFA rehearsal passed on the final candidate; M21 logout revocation confirmed on staging.
- [ ] Verified production backup; restore procedure tested on staging.
- [ ] Disable the GHL webhook (or confirm nothing posts to it) before promoting a P7 build.
- [ ] Reconcile production migration history exactly as rehearsed; then push the required manifest (§5), the same files staging received. Never M15.
- [ ] Bootstrap George as platform admin, enrol MFA, provision F&A, accept the owner invitation.
- [ ] Set `AUTH_PROVIDER=supabase`; promote the build. Keep the legacy `AUTH_*` credentials in place.
- [ ] Smoke: login with MFA, dashboard, contacts, pipeline, calendar, tasks, inbox notes, settings/team, `/api/health` reports `authProvider: "supabase"`.
- [ ] Rollback path ready: set `AUTH_PROVIDER=legacy` and promote `release` @ `9c189f8` (or the last legacy-compatible build). Export native tables first if real data was written (spec §11).

## 3. After 14 stable days (T6, then M15) — separate approval

- [ ] Remove legacy auth code, `AUTH_OWNER_*`/`AUTH_ADMIN_*`/`AUTH_CLIENT_*`, and `fna_session` handling; remove the legacy snapshot files listed in spec §21.3.
- [ ] Verified backup, then write and apply M15 (drop `sync_*`, `auth_sessions`). **Not written in this program.**

## 4. Local journey coverage (evidence for the rehearsal)

| Journey | Acceptance test (fresh stack) | Real-stack suite test(s) |
| --- | --- | --- |
| Provisioning (idempotent, link shown once) | 2 | provisioning through the app; concurrent provisioning |
| Invitation acceptance (new and existing account) | 3 | INV-1/2/6/7, INV public preview, INV-3/4 (expiry, revocation, mismatch, concurrency) |
| Login and MFA | 1 | AUTH-1; MFA through the app; P6 denial |
| Workspace switching | 7 | /api/workspaces …; workspace switching |
| Settings and team management | 4 | ROLE-1..8; SET-1..7; browser team flow |
| Contacts, opportunities, calendars/appointments, tasks, internal notes | 5 | CRUD-1..5; browser records flow |
| Permission overrides | 6 | permission overrides …(PostgREST and Storage); CRUD-4 |
| Suspension and reactivation | 12 | MEM-1 and SUSP-1; SUSP; suspension from the console |
| Access removal | 13 | ROLE-7 and MEM-1/2/4; a removed member loses access immediately |
| Platform support grants (read, write, end, expiry) | 11 | support grants; one-minute grant expiry; platform access requires a grant |
| Isolation and audit accuracy | 5, 6, 12, 13, 16 | ISO; RLS isolates workspaces; forged actor attribution |
| Malformed requests | 8 | JSON bodies must be objects…; unit "malformed ids, bodies, queries" |
| Concurrency | 9 | concurrent provisioning…; CRUD-3 overlap under concurrency |
| Pagination | 10 | CRUD-1 keyset pages; search and keyset paging |
| Cookie refresh | — | refreshed sessions reach the browser |
| Expiry (token, invitation, grant) | 11 | ISO-F3 (expired cookies); INV-3/4; one-minute grant |
| Failure recovery | — | AUTH-1 failed sign-ins (generic 401/429); unit tests map an unreachable Auth server to 503 |
| Logout and replay (M21) | 14; product rehearsal "logout across tabs" | AUTH-1; platform Storage endpoint; sensitive actions re-check the session |
| Employee overrides, business hours, logos, full board | product rehearsal | permission overrides (PostgREST and Storage) |
| Platform-admin bootstrap and MFA recovery | — | `tests/supabase-stack/bootstrap.test.ts` |
| Legacy mode, no GHL | 15 | tenant config, public branding, health, and retired legacy endpoints |
| No outbound requests | 15, 16 | NET-1 |
| Navigation and design | 5 (sidebar) | UI-1 (all destinations, empty states); UI-2 visual run |

## 5. Required migration manifest (staging, then production)

Exactly these files, in this order. `tests/db/migrations.test.ts` fails if this list and `supabase/migrations/` disagree.

| # | File |
| --- | --- |
| legacy | `20260917121316_sync_store.sql` |
| legacy | `20260917185155_auth_sessions.sql` |
| M1 | `20261101000100_extensions_schemas.sql` |
| M2 | `20261101000200_identity_platform.sql` |
| M3 | `20261101000300_membership_access.sql` |
| M4 | `20261101000400_authz_helpers.sql` |
| M5 | `20261101000500_workspace_config.sql` |
| M6 | `20261101000600_crm_core.sql` |
| M7 | `20261101000700_scheduling.sql` |
| M8 | `20261101000800_engagement_audit.sql` |
| M9 | `20261101000900_triggers_integrity.sql` |
| M10 | `20261101001000_rls_policies_grants.sql` |
| M11 | `20261101001100_rpc_membership_invites.sql` |
| M12 | `20261101001200_rpc_platform_provisioning.sql` |
| M13 | `20261101001300_storage_reporting_views.sql` |
| M14 | `20261101001400_legacy_lockdown.sql` |
| M16 | `20261101001500_auth_session_platform_storage.sql` |
| M17 | `20261101001600_team_settings.sql` |
| M18 | `20261101001700_native_crm.sql` |
| M19 | `20261101001800_platform_console.sql` |
| M20 | `20261101001900_availability_lock.sql` |
| M21 | `20261101002000_session_revocation.sql` |
| M22 | `20261101002100_platform_admin_guard.sql` |
| M23 | `20261101002200_booking_lock.sql` |
| M24 | `20261101002300_invitation_authority.sql` |
| M25 | `20261101002400_appointment_rules.sql` |
| M26 | `20261101002500_integrity_round3.sql` |
| M27 | `20261101002600_end_user_sessions.sql` |

**Excluded: M15** (drop `sync_*` and `auth_sessions`). It is destructive, deferred until after T6 and a verified backup (§3), and not written. The legacy files are reconciled per `docs/MIGRATION_VERSION_MAPPING.md` rather than re-applied blindly.

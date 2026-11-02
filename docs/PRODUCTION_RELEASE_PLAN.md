# Production release plan (proposal — not approved, not executed)

Status on 2026-11-02:

- Staging validation is complete (`docs/STAGING_CUTOVER_CHECKLIST.md` §1).
- The hosted MFA-recovery rehearsal (Gate B, §7) passed on staging with M27 applied.
- The read-only production preflight below has been run with George's authorization.

**Production is not ready.** It needs George's decisions (§10), then three separately approved stages (§9):

1. backup and preflight;
2. database changes;
3. application cutover, which includes the merge to `release`, because that push deploys production.

Nothing has been written to production, Vercel or GHL.

Preflight method: Supabase metadata and catalog queries (schema, constraints, grants, policies, role settings, migration history, aggregate row counts — never row contents), the Auth settings endpoint, and Vercel project, deployment, domain and environment-variable **name** listings. No secret value was printed or stored.

## 1. Identities (verified 2026-11-02)

| Item | Value |
| --- | --- |
| Production Supabase project | "fna-business-dashboard", ref `rbghfpwbwmrjbpjswbbn`, `us-east-1`, ACTIVE_HEALTHY, PostgreSQL 17.6, created 2026-09-17 |
| Organization | Fortune&Finance (`qrmawcinoleswjhiuukr`), **Free plan** |
| Staging | `fna-staging`, same organization and region; ref in the runbook |
| Vercel team | "Fortune" (`fortuneautomations`), Hobby plan (runtime logs kept 1 hour) |
| Vercel project | `fna-client-app` (`prj_BK0RcmttBLy2zDj24S6OMuxF1gYs`), Node 24 |
| Linked repository | GitHub `FortuneGroot/fna-business-dashboard` (private) |
| Production branch | `release` (pushes to `release` built production; pushes to `main` build previews) |
| Live production deployment | `dpl_Gw82ZbYSBmbVv8Sc7Smp24NoA3Kr`, created 2026-11-01 08:02 UTC, a CLI redeploy of commit `9c189f8` ("Remove protected Master location ID from client bundles via server-only split"); legacy auth, GHL webhook live |
| Rollback candidates | `dpl_2rchR1sX3FbM9DjxmjpCeqZwYCCw` (same commit, 08:00), then the original `release` build `dpl_HNLo3Qida5hbwnT51my3iXCaNgdj` (2026-09-20) |
| Domains | `fna-client-app.vercel.app` only; no custom domain |
| Deployment Protection | Vercel Authentication on deployment URLs, not on the production domain; `/login` and `/api/health` answer anonymously |
| Candidate release build | branch `feat/native-multi-tenant` @ `bcd2b0b` (later commits are documentation only); results in `docs/RELEASE_HANDOFF.md` §5 |

Production environment variable names: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_SECRET`, `AUTH_OWNER_EMAIL`, `AUTH_OWNER_PASSWORD`, `GHL_WEBHOOK_SECRET`, `GHL_WEBHOOK_ENFORCE_SECRET`, `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`, `FORBIDDEN_MASTER_LOCATION_ID`, `FAKE_CONTACT_ONLY`, `ALLOW_PRODUCTION_CONTACT_WRITES`, `GHL_DRY_RUN`. `GHL_API_TOKEN` exists for preview only. Absent: `AUTH_PROVIDER` (so legacy is the default), `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN`, `CLIENT_CONFIG_PATH`, `AUTH_ADMIN_*`, `AUTH_CLIENT_*`.

## 2. Production database findings

- **Schema:** only the two legacy files' objects exist — nine `sync_*` tables and `public.auth_sessions`. No `private` schema, no native table, no Storage bucket, no Realtime publication. Extensions: `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `supabase_vault`.
- **Structure matches the repository exactly.** Every column (type, nullability, default), primary key, unique key, check constraint (the protected-location guard on each `sync_*` table), foreign key and index equals what `20260917121316_sync_store.sql` and `20260917185155_auth_sessions.sql` create. The recorded SQL differs from the local file only in comments and line wrapping.
- **Migration history:** one row, `20260917122941 sync_store` (applied through the dashboard on 2026-09-17). There is no row for `auth_sessions`, although the table exists. This is a fourth case not covered by `docs/MIGRATION_VERSION_MAPPING.md` (row under a different version; second file applied without a row).
- **Auth:** 0 Auth users. Public sign-up is **enabled** (`disable_signup=false`; staging has it off). Email confirmation is on.
- **Role settings:** no `pgrst.db_pre_request` yet (M21 adds it); statement timeouts as Supabase defaults.
- **Security exposure (existing, not caused by this release):** RLS is **off** on all nine `sync_*` tables while `anon` and `authenticated` hold every table privilege, and the legacy anon key is enabled. Anyone holding the project's anon key can read and change those tables through the Data API. The Supabase advisor reports this at ERROR level. The app itself does not ship the anon key (no public Supabase variables in Vercel), and the tables hold one row of contact data (§5), so current impact is small. `auth_sessions` has RLS on with no policies, so it is closed despite the same grants. M14 closes all ten tables. I did not test the exposure with the anon key, because that would read customer rows.

## 3. Migration-history reconciliation (proposal; each command is a production write)

1. `supabase migration repair --status reverted 20260917122941` — removes the dashboard row (history only; no schema change).
2. `supabase migration repair --status applied 20260917121316 20260917185155` — records the two legacy files, whose objects already exist with identical structure (§2).
3. `supabase migration list` — remote must show exactly those two versions before anything else.
4. `supabase db push --dry-run` — must list exactly M1–M14 and M16–M27 (`STAGING_CUTOVER_CHECKLIST.md` §5), never M15.
5. `supabase db push`, then `migration list` (local and remote equal). Verify M21 (`pgrst.db_pre_request` on `authenticator`), M14 (ten legacy tables closed to `anon`/`authenticated`), RLS on every public table, no Realtime tables, and the advisor's `rls_disabled_in_public` errors gone.

Alternative, not recommended: keep `20260917122941` by adding a matching local file. It would put two copies of the same DDL in the repository and leave the `auth_sessions` row missing.

The legacy deployment keeps working during and after the push: it uses the service role, which M14 does not affect (stack test "legacy tables are closed to anon and authenticated, open to the service role"). No native object is used in legacy mode.

**Optional early lockdown (decision D4):** M14 alone can be applied before the release, which closes the exposure in §2 now. It only revokes grants and enables RLS, keeps explicit service-role access (the legacy app's only access path), skips missing tables, and is the same file the release pushes later. It is still a production write and needs its own approval.

Mechanism: after steps 1–3 above, run the M14 file in one transaction (SQL editor or `psql`), then `supabase migration repair --status applied 20261101001400`. Step 4 then needs `supabase db push --include-all`, because M1–M13 sort before an applied version. That is the same sequence staging used.

## 4. GHL webhook dependency

- The live build (`9c189f8`) accepts `POST /api/webhooks/ghl`. In production it always enforces the shared secret (header `x-ghl-signature` or `x-webhook-secret`), accepts only the configured location, and writes to the `sync_*` tables. `GHL_DRY_RUN` does not stop those writes. Other legacy routes: `/api/ghl/health`, `/api/sync/health`, `/api/leads`, `/api/events`, `/api/dashboard/events`.
- Evidence of use: the last successful ingestion was 2026-09-17 (one contact, one event). Nothing has been stored since, so either no GHL workflow posts to the endpoint or every post fails. Vercel's 1-hour log retention cannot show which.
- GHL's own configuration is not visible from here. George checks in GHL for workflow "Webhook" actions pointing at `https://fna-client-app.vercel.app/api/webhooks/ghl` (decision D2).
- A P7 build has no webhook route: posts would get 404 and the legacy snapshot stops updating. If workflows exist, disable those actions at cutover. Native mode never contacts GHL.
- Keep until T6, so that `AUTH_PROVIDER=legacy` remains a rollback: `AUTH_SECRET`, `AUTH_OWNER_*`, `GHL_LOCATION_ID`. Inert from P7 on: `GHL_PIPELINE_ID`, `GHL_WEBHOOK_*`, `GHL_DRY_RUN`, `FAKE_CONTACT_ONLY`, `ALLOW_PRODUCTION_CONTACT_WRITES`, `FORBIDDEN_MASTER_LOCATION_ID`. Remove them after T6, not at cutover.
- Add for native mode: `AUTH_PROVIDER=supabase`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN` (the production origin). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exist already.

## 5. Existing-data transition assessment (GHL legacy data)

What production holds (aggregate counts, 2026-11-02):

| Data | Rows | Notes |
| --- | --- | --- |
| `sync_contacts` | 1 | one location; written 2026-09-17 13:00 |
| `sync_contact_tags` | 1 | belongs to that contact |
| `sync_events` | 1 | 2026-09-17 13:26 |
| `sync_idempotency` | 1 | webhook de-duplication key, no business value |
| opportunities, appointments, tasks, conversation events, review events | 0 | |
| `auth_sessions` (legacy login) | 6 | all OWNER, two owner email addresses, 0 live; not business data |
| Auth users, Storage objects | 0 | |

The deployment ran with `FAKE_CONTACT_ONLY` set, so the contact is probably the end-to-end test contact. George confirms (D1); I have not read its contents.

- **Importer:** none exists. Nothing in the repository copies `sync_*` rows into native tables; `src/lib/legacy/snapshot.ts` is a read-only view for legacy mode.
- **Preservation without import:** the release never changes legacy rows. M14 changes grants only, M15 (which drops the tables) is excluded, and the legacy view stays available while `AUTH_PROVIDER=legacy` is a rollback (until T6).
- **If the contact is real and wanted in native mode:** for one contact and one tag, re-entering it in the native CRM after provisioning is cheaper and more reliable than building an importer. An importer becomes worthwhile only if GHL holds real data that was never synced. That is out of scope here, because native mode does not read GHL at all.
- **No importer will be built for this release.** Native `public.contacts` has no field that keeps a GHL contact id, so an importer would have to invent that contract. Building one needs George's later authorization of a scoped import project, based on real volumes and an agreed external-id mapping. Until then, D1 is either an empty start or manual re-entry.
- **Legacy login users:** only the owner account. It is not migrated; George signs in to native mode with his new Supabase account and MFA (§9, stage 2).

## 6. Gate A — preservation of existing data (must pass before promotion)

| Requirement | State |
| --- | --- |
| Backup of production taken before the push and its digests verified (§8) | Procedure implemented and rehearsed on staging (5/5); **not run on production** |
| Per-table row counts and server-side content digests (`md5` of each table's ordered rows, computed in the database; no contents leave it) recorded before the push and compared after it and after promotion | Procedure defined here; **not run** |
| History reconciliation leaves the legacy tables' structure, data and digests unchanged | Planned (§3); legacy files are idempotent (`if not exists`) |
| D1 answered: the legacy contact is test data, or is re-entered in native mode | **Open** |
| Legacy rows stay intact and readable through `AUTH_PROVIDER=legacy` until T6; M15 needs a separate approval with a verified backup | Implemented (M15 excluded; manifest test enforces it) |

## 7. Gate B — MFA recovery (implemented functionality vs policy)

**Implemented and tested, locally and on hosted staging (code `bcd2b0b`):**

- M27 `platform_end_user_sessions` (service role only) deletes every Auth session of the account. Refresh tokens and MFA claims go with them by cascade. One audit row with the session count is written in the same transaction.
- `bootstrap-platform-admin.ts remove-mfa` runs in this order:
  1. writes a start record;
  2. ends every session of the account, with its audit record;
  3. deletes the factors;
  4. re-reads them;
  5. records the outcome.

  If sessions cannot be ended, no factor is deleted (outcome `sessions_not_ended`, exit 5).
- `end-sessions` signs one account out everywhere without touching MFA (for example, a stolen laptop).
- Evidence (`tests/supabase-stack/bootstrap.test.ts`, real GoTrue/PostgREST):
  - before recovery, the lost device's AAL2 token, its refresh token and a second device all work;
  - after recovery, both old access tokens get 401 from the Data API (`platform_status` and `request_context`, the app's own session check), and Auth refuses them;
  - the old refresh token cannot mint a session, and the old token cannot enrol a replacement authenticator;
  - other users keep their sessions;
  - password sign-in gives AAL1 without platform access, and new TOTP enrolment restores AAL2 platform access;
  - the start, sessions-ended and outcome audit rows share one operation id;
  - `anon` and `authenticated` cannot call the function.

**Hosted rehearsal on `fna-staging` (2026-11-02, `tests/staging/mfa-recovery.test.ts`, PASS 4/4).** M27 was applied to staging alone, after confirming the project identity and its 27-row history (now 28, latest `20261101002600`; only `service_role` may execute the function). The real `remove-mfa` code ran against staging for a synthetic `@example.test` admin, through the locally built app in supabase mode. Results:

- **Before recovery:** the lost device's AAL2 token reached platform functions, its refresh token rotated, its app cookie showed a platform admin, and a second device was signed in.
- **Partial failure:** the sessions-ended audit insert was forced to fail for this one synthetic user only, using a temporary trigger that was removed afterwards. The command exited 5 and deleted no factor. The session deletion rolled back with the audit row. The audit shows `started` followed by `incomplete: sessions_not_ended` under one operation id.
- **Recovery:** 2 sessions ended and 1 factor was removed, exit 0. Both old access tokens got 401 from the Data API and were refused by Auth. The old refresh token was refused, the old token could not enrol a replacement authenticator, and the old app cookie read as signed out. The audit shows `started`, `sessions_ended` (2) and `factors_removed` (complete, 2), sharing one operation id and the ticket reason.
- **Other users unaffected:** a synthetic bystander's token and app session kept working. George's account was fingerprinted before, during and after (user, password hash, MFA factor, session, platform-admin row) and was identical each time.
- **Re-enrolment:** password sign-in gave AAL1 without platform access, and a new TOTP factor restored AAL2 platform access.
- **Cleanup:** the synthetic admin was revoked and both synthetic users were deleted. Staging is back to George as the only user and admin, with 0 workspaces. The audit rows are kept as evidence.
- Not rehearsed on hosted staging (covered by local unit tests only): a factor deletion that fails partway, and a factor list that cannot be re-read.

**Operational policy, not code, and not a spec requirement:**

| Item | Status |
| --- | --- |
| Who may run `remove-mfa` | The spec says recovery is done by "another platform admin or the operator" (spec §20.4, item 4), and leaves the policy as an open decision (spec §24.2). The tool needs the service-role key, not a second admin account. Proposal: George, or the technical operator who holds the production service-role key, runs it. |
| A second platform admin | **Not a spec requirement and not a release blocker.** It is an optional availability measure, so that platform functions do not depend on one person's device. Never a shared account. |
| Identity check before recovering someone else's account | Proposal: call back to a number recorded in advance, plus a one-time code to the account email; the ticket reference is the `--reason`. Not enforced by tooling. When George recovers his own account with the service key, no extra check applies. |
| Password reset when the password may also be known | Manual: Auth "Send password recovery" or the admin API. Ending sessions does not change the password. |
| Repeat the hosted rehearsal | After any change to Auth, M21, M27 or the CLI: `tests/staging/mfa-recovery.test.ts`. |

Excluded: recovery codes, email-only MFA reset, any AAL1 fallback to platform functions (M26 removed it), and shared admin accounts.

## 8. Backup options and limitations

- **Free plan reality:** the production organization is on the Free plan. Supabase keeps daily backups and point-in-time recovery for Pro and above only, and recommends that Free projects export with `db dump` and keep copies off-site. Today there is **no managed restore point for production**.
- **Option A, $0:** the explicit export (`docs/BACKUP_RESTORE_REHEARSAL.md`, hosted section, rehearsed 5/5 on staging), taken during a short write freeze before the push.
  - Covers Auth (including password hashes and MFA factors), app and legacy data, ownership, policies, grants, triggers, role settings, migration history, and Storage metadata and files.
  - Limitations: there is no point-in-time recovery, so recovery returns to the export moment. The export contains credentials and must be stored encrypted with restricted access. A hosted restore goes either in place or into a new project, and a new project needs a free slot (see the recovery-capacity table below).
- **Option B, paid (Pro, about $25 per month per organization plus compute):** 7 days of daily backups, restored in place from the dashboard (the project is down during the restore).
  - Storage files are not included, so the explicit file export is still needed.
  - Point-in-time recovery is a further add-on (about $100 per month for 7 days, and it needs at least the Small compute size).
- Both options: the backup must exist and be verified before stage 2 of §9. Restoring into the live project replaces everything written after the backup.

**Recovery capacity of Option A (both Free project slots are taken by production and staging; staging is not deleted to make room):**

| Purpose | Destination | Approval needed | Capacity |
| --- | --- | --- | --- |
| Prove the production export is restorable (stage 1) | A disposable **local** Supabase stack on the operator's machine, the same path rehearsed on staging | Covered by the stage 1 approval: it handles real data, including password hashes, on that machine, and the copy is deleted afterwards | Staging rehearsal: export about 44 s, restore and verification about 57 s for about 10,000 rows. Production is far smaller today. |
| Recover after a bad release | No restore needed. The schema change is additive and legacy rows are untouched, so application rollback (below) is enough | Rollback is part of the stage 3 approval | Minutes (a Vercel promote) |
| Recover damaged production data | **In place**, into `rbghfpwbwmrjbpjswbbn`, replaying the export with the same procedure | A production write, approved at the time | Returns to the export moment; the write freeze makes that lossless for the cutover window. Not rehearsed against a hosted target. |
| Recover a lost production project | A **new hosted project**. Pausing `fna-staging` frees a slot: a paused project keeps its data and is resumed from the dashboard. Alternatively, Option B. | George approves pausing staging at that moment, plus a Vercel production change (new `SUPABASE_URL` and keys, then redeploy) | Project creation, restore and redeploy; not rehearsed. Restore duration is the same order as above. |

The `Fortune&Finance Academy` project is already paused, so it frees no slot, and it is not used.

Rollback, from least to most invasive:

1. **Application:** set `AUTH_PROVIDER=legacy` and promote `dpl_Gw82ZbYSBmbVv8Sc7Smp24NoA3Kr` (or `dpl_2rchR1sX3FbM9DjxmjpCeqZwYCCw`). Re-enable any GHL webhook actions that were disabled. This works because the native schema is additive and the legacy credentials are kept.
2. **Native data:** export it (explicit procedure) before rolling back, if real records were created.
3. **Database:** leave the native schema in place; it does not affect legacy mode. `supabase/rollback/…down.sql` is for staging only and is not planned for production. Restoring the pre-push backup is the last resort.

## 9. Release sequence: three separate approvals

Done, no production effect:

- Staging validation.
- M27 on `fna-staging` and the hosted MFA-recovery rehearsal (Gate B evidence, §7).

These come before every production step.

Pushing to `release` deploys production, because Vercel builds and promotes it automatically. So the merge to `release` is part of the application cutover (stage 3), never an earlier step. Production environment-variable changes also belong to stage 3: they take effect on the next deployment, and any redeploy would pick them up.

**Stage 1 — backup and preflight (approval A1; no production schema or app change)**

1. George provides the production database connection string into the operator's ignored local env file.
2. Write freeze: nobody uses the legacy app during the window.
3. Take the explicit export of `rbghfpwbwmrjbpjswbbn` (§8 Option A, or the managed backup under Option B, plus the file export).
4. Restore it into a disposable local stack and verify its digests. Store the export encrypted.
5. Record the Gate A per-table row counts and server-side digests.

**Stage 2 — database changes (approval A2; the live legacy app keeps working throughout)**

1. Turn off public sign-up on `rbghfpwbwmrjbpjswbbn` (`disable_signup=true`), and confirm email confirmation and TOTP are on.
2. Reconcile history (§3 steps 1–3).
   - If D4 chose early M14, it was already applied under its own approval with the same mechanism, and the push uses `--include-all`.
3. `db push --dry-run`: it must list exactly M1–M14 and M16–M27 of `bcd2b0b`. Then `db push`.
4. Verify M14, M21, M27, RLS on every public table, no Realtime tables, and the advisors. Re-check the Gate A digests: they must be unchanged.
5. Create George's Auth user from the dashboard (sign-up is off), then run `bootstrap-platform-admin.ts grant --env production`.
   - He enrols MFA at `/platform/mfa` once stage 3 has deployed the native app. Until then, the native tables are unused.

**Stage 3 — application cutover (approval A3; the final release approval)**

1. Disable GHL webhook actions, if D2 found any.
2. In Vercel `fna-client-app`, production environment: add `AUTH_PROVIDER=supabase`, `SUPABASE_PUBLISHABLE_KEY` and `APP_ORIGIN=https://fna-client-app.vercel.app`. Keep the legacy variables.
3. Merge `bcd2b0b` (or its docs-only descendant) into `release` and push. This is the production deployment.
4. Smoke tests:
   - `/api/health` reports `authProvider: "supabase"` and `db: "ok"`;
   - George signs in, enrols TOTP, and reaches the platform console at AAL2;
   - every page loads;
   - an anonymous request to `/api/contacts` is refused;
   - the Gate A digests are unchanged.
5. Provision F&A (`fa-live`, §11) from the platform console and accept the owner invitation. Re-enter the legacy contact if D1 says it is real.
6. Keep rollback ready for 14 days. Then T6, then M15 only with a verified backup and a separate approval.

**Optional, before A3 (decision D6): a protected preview that is genuinely isolated.** Today, preview deployments have no `SUPABASE_*` or `AUTH_*` variables, so a preview of the candidate would fail closed and prove nothing. Making it useful needs two authorizations, neither of them a production change:

1. preview environment variables scoped to the git branch `feat/native-multi-tenant`, pointing at `fna-staging` (`AUTH_PROVIDER=supabase`, staging URL and keys, the preview origin);
2. pushing that branch, not `release`.

The preview URL is behind Vercel Authentication. It would add a check of the Vercel runtime that the locally built app cannot give. The staging validation already passed with the same build run locally.

Rollback triggers in stage 3, any one of which means application rollback (§8 step 1: `AUTH_PROVIDER=legacy`, promote `dpl_Gw82ZbYSBmbVv8Sc7Smp24NoA3Kr`):

- a smoke-test failure;
- George cannot reach AAL2 platform access;
- any cross-business data visible;
- a Gate A digest mismatch on the legacy tables;
- `/api/health` not reporting supabase mode;
- sustained 5xx on login or dashboard pages.

## 10. Decisions and approvals George needs to give

Decisions:

| # | Decision | Needed before |
| --- | --- | --- |
| D1 | The single legacy contact: test data (native starts empty; legacy rows stay read-only until T6), or real (re-enter it after cutover). | Stage 3 |
| D2 | Fact check in GHL: does any workflow post to `/api/webhooks/ghl`? If yes, those actions are disabled in stage 3. | Stage 3 |
| D3 | Backup: Option A ($0 export; recovery capacity in §8), or Option B (Pro; then also turn on leaked-password protection). | Stage 1 |
| D4 | M14 now, alone, to close the open legacy tables (its own small production-write approval), or with the stage 2 push. | Stage 2 |
| D5 | Who may run `remove-mfa` on production: George, or George plus a named operator holding the service key. A second platform admin is optional (§7). | Stage 3 |
| D6 | Optional: authorize the staging-backed protected preview (branch-scoped preview variables plus a push of the candidate branch, not `release`). | Before A3, if wanted |

Approvals, each given separately and only after the previous stage passes: **A1** backup and preflight, **A2** database changes, **A3** application cutover (merge to `release` = production deployment).

## 11. Real F&A provisioning data (needed in stage 3)

Provision on production only, never on staging (staging has weaker controls and its harnesses refuse non-synthetic workspaces). Needed from George: display name; slug (provisioning key `fa-live`); owner email; time zone and business hours; support email and phone; website, booking link and review link; logo file.

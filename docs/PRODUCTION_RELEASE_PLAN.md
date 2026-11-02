# Production release plan (proposal — not approved, not executed)

Status on 2026-11-02: staging gates are complete (`docs/STAGING_CUTOVER_CHECKLIST.md` §1) and the read-only production preflight below has been run with George's authorization. **Production is not ready.** Two gates (§6 data preservation, §7 MFA recovery) and George's decisions (§10) come first, and the cutover itself is a separate, final approval (§9 step 10). Nothing has been written to production, Vercel or GHL.

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

**Optional early lockdown (decision D2):** M14 alone can be applied before the release, which closes the exposure in §2 now. It only revokes grants and enables RLS, keeps explicit service-role access (the legacy app's only access path), skips missing tables, and is the same file the release pushes later. It is still a production write and needs its own approval.

Mechanism: after steps 1–3 above, run the M14 file in one transaction (SQL editor or `psql`), then `supabase migration repair --status applied 20261101001400`. Step 4 then needs `supabase db push --include-all`, because M1–M13 sort before an applied version. That is the same sequence staging used.

## 4. GHL webhook dependency

- The live build (`9c189f8`) accepts `POST /api/webhooks/ghl`. In production it always enforces the shared secret (header `x-ghl-signature` or `x-webhook-secret`), accepts only the configured location, and writes to the `sync_*` tables. `GHL_DRY_RUN` does not stop those writes. Other legacy routes: `/api/ghl/health`, `/api/sync/health`, `/api/leads`, `/api/events`, `/api/dashboard/events`.
- Evidence of use: the last successful ingestion was 2026-09-17 (one contact, one event). Nothing has been stored since, so either no GHL workflow posts to the endpoint or every post fails. Vercel's 1-hour log retention cannot show which.
- GHL's own configuration is not visible from here. George checks in GHL for workflow "Webhook" actions pointing at `https://fna-client-app.vercel.app/api/webhooks/ghl` (decision D3).
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
- **Legacy login users:** only the owner account. It is not migrated; George signs in to native mode with his new Supabase account and MFA (§9 step 6).

## 6. Gate A — preservation of existing data (must pass before promotion)

| Requirement | State |
| --- | --- |
| Backup of production taken before the push and its digests verified (§8) | Procedure implemented and rehearsed on staging (5/5); **not run on production** |
| Per-table row counts and server-side content digests (`md5` of each table's ordered rows, computed in the database; no contents leave it) recorded before the push and compared after it and after promotion | Procedure defined here; **not run** |
| History reconciliation leaves the legacy tables' structure, data and digests unchanged | Planned (§3); legacy files are idempotent (`if not exists`) |
| D1 answered: the legacy contact is test data, or is re-entered in native mode | **Open** |
| Legacy rows stay intact and readable through `AUTH_PROVIDER=legacy` until T6; M15 needs a separate approval with a verified backup | Implemented (M15 excluded; manifest test enforces it) |

## 7. Gate B — MFA recovery (implemented functionality vs policy)

**Implemented and tested (local stack, commit in `docs/RELEASE_HANDOFF.md`):**

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

**Not implemented — these are policy and operations, so they need people and a rehearsal:**

| Requirement | State |
| --- | --- |
| A second named platform admin enrolled with MFA, so recovery never depends on the person who lost the device | **Open (D5)** |
| Identity verification before recovery: call back to a number recorded in advance, plus a one-time code to the account email, plus a live video check. A ticket reference is the `--reason`. Requests by email or chat alone are never enough. | Policy proposal; no tooling enforces it |
| Password reset when the password may also be known: Auth dashboard "Send password recovery", or reset through the admin API. Ending sessions does not change the password. | Manual step; not automated |
| Hosted rehearsal on staging with a synthetic admin (enrol → `remove-mfa` → old tokens refused → re-enrol), then quarterly | **Not run** (this round was local only); required before promotion |
| Notify all platform admins and the affected user after each recovery | Policy; manual |

Excluded: recovery codes, email-only MFA reset, any AAL1 fallback to platform functions (M26 removed it), and shared admin accounts.

## 8. Backup options and limitations

- **Free plan reality:** the production organization is on the Free plan. Supabase keeps daily backups and point-in-time recovery for Pro and above only, and recommends that Free projects export with `db dump` and keep copies off-site. Today there is **no managed restore point for production**.
- **Option A, $0:** the explicit export (`docs/BACKUP_RESTORE_REHEARSAL.md`, hosted section, rehearsed 5/5 on staging), taken during a short write freeze before the push.
  - Covers Auth (including password hashes and MFA factors), app and legacy data, ownership, policies, grants, triggers, role settings, migration history, and Storage metadata and files.
  - Limitations: there is no point-in-time recovery, so recovery returns to the export moment. The export contains credentials and must be stored encrypted with restricted access. A restore goes into a *new* project, which needs a free project slot (the Free organization has two active projects, the maximum).
- **Option B, paid (Pro, about $25 per month per organization plus compute):** 7 days of daily backups, restored in place from the dashboard (the project is down during the restore).
  - Storage files are not included, so the explicit file export is still needed.
  - Point-in-time recovery is a further add-on (about $100 per month for 7 days, and it needs at least the Small compute size).
- Both options: the backup must exist and be verified before step 4 of §9. Restoring into the live project replaces everything written after the backup.

Rollback, from least to most invasive:

1. **Application:** set `AUTH_PROVIDER=legacy` and promote `dpl_Gw82ZbYSBmbVv8Sc7Smp24NoA3Kr` (or `dpl_2rchR1sX3FbM9DjxmjpCeqZwYCCw`). Re-enable any GHL webhook actions that were disabled. This works because the native schema is additive and the legacy credentials are kept.
2. **Native data:** export it (explicit procedure) before rolling back, if real records were created.
3. **Database:** leave the native schema in place; it does not affect legacy mode. `supabase/rollback/…down.sql` is for staging only and is not planned for production. Restoring the pre-push backup is the last resort.

## 9. Ordered release checklist

1. George answers D1–D7 (§10).
2. (If D2 approves) take the Option A export, reconcile history (§3 steps 1–3), apply M14 alone (§3 mechanism), verify the advisor errors are gone and the legacy app still logs in and reads its snapshot.
3. Turn off public sign-up on production Auth (`rbghfpwbwmrjbpjswbbn`: `disable_signup=true`) and confirm email confirmation and TOTP are on, as on staging.
4. Write freeze; backup of `rbghfpwbwmrjbpjswbbn` (§8); record Gate A row counts and digests.
5. Reconcile history and push `bcd2b0b`'s manifest (§3); verify M14, M21, M27, RLS, Realtime, advisors; re-check the Gate A digests.
6. Bootstrap George as platform admin, enrol MFA; bootstrap the second admin (D5).
7. Gate B: push M27 to `fna-staging` (staging write, needs authorization), then run the hosted MFA-recovery rehearsal there with a synthetic admin; record the evidence.
8. Provision F&A (`fa-live`) on production (data in §11) and accept the owner invitation; re-enter the legacy contact if D1 says so.
9. Merge `bcd2b0b` (or a docs-only descendant) into `release`, the production branch of Vercel project `fna-client-app`, so a production build exists; set native env vars, keeping the legacy ones.
10. **Separate final approval (cutover):** disable GHL webhook actions (if D3 finds any), set `AUTH_PROVIDER=supabase`, promote, smoke-test (MFA login, every page, `/api/health` reports `authProvider: "supabase"`), re-check Gate A digests.
11. Keep rollback ready (§8) for 14 days; then T6, then M15 only with a verified backup and a separate approval.

Rollback triggers, any one of which means application rollback (§8 step 1: `AUTH_PROVIDER=legacy`, promote `dpl_Gw82ZbYSBmbVv8Sc7Smp24NoA3Kr`):

- a smoke-test failure;
- George cannot reach AAL2 platform access;
- any cross-business data visible;
- a Gate A digest mismatch on the legacy tables;
- `/api/health` not reporting supabase mode;
- sustained 5xx on login or dashboard pages.

## 10. Decisions George needs to make

| # | Decision | Why it matters |
| --- | --- | --- |
| D1 | The single legacy contact: test data (start native empty, keep legacy rows read-only until T6), or real (re-enter it in native mode). | Gate A |
| D2 | Apply M14 alone now to close the open legacy tables (production write), or wait for the release push. | Existing exposure (§2) |
| D3 | In GHL, do any workflows post to `/api/webhooks/ghl`? If yes, approve disabling those actions at cutover. | Cutover breaks them otherwise |
| D4 | Backup: Option A ($0 export, no point-in-time recovery) or Option B (Pro plan). | Gate A; spending |
| D5 | Name the second platform admin, and approve the identity-verification policy in §7. | Gate B |
| D6 | Leaked-password protection (Pro setting): accept it off, or enable it with D4 Option B. | Auth hardening |
| D7 | Approve the production writes in steps 2–9 (sign-up off, backup, history repair, push, bootstrap, provisioning, merge to `release`). | Everything before cutover |

Cutover (step 10) remains a separate, final approval after Gates A and B pass.

## 11. Real F&A provisioning data (needed at step 8)

Provision on production only, never on staging (staging has weaker controls and its harnesses refuse non-synthetic workspaces). Needed from George: display name; slug (provisioning key `fa-live`); owner email; time zone and business hours; support email and phone; website, booking link and review link; logo file.

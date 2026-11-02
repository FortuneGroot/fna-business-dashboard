# Backup and restore rehearsal (synthetic, local)

This rehearsal shows that the native multi-tenant data can be exported from one environment and restored into a separate fresh environment. Everything in it runs on disposable local Supabase stacks with synthetic users. It is not a production backup procedure. For production, use Supabase's managed backups and point-in-time recovery (see "Production" below).

- Test: `tests/acceptance/backup-restore.test.ts`
- Tooling: `tests/supabase-stack/backup.ts`, plus the `portOffset` and `stackDocker` helpers in `tests/supabase-stack/stack.ts`
- Run it with: `node --require ./scripts/stub-server-only.cjs --import tsx --test --test-timeout=1800000 tests/acceptance/backup-restore.test.ts`
- Duration: about 2.5 minutes, because it starts two complete stacks. Both stacks and the export directory are removed when it finishes.

## What the rehearsal does

1. **Stack A (source)** starts on the default test ports with the app.
   - Two businesses are provisioned, each with a different owner: "Harbor Physio (synthetic)" in America/New_York and "Ridge Landscaping (synthetic)" in America/Denver.
   - Each owner populates their business through the app:
     - workspace settings and an AI receptionist configuration;
     - tagged contacts, with a contact note;
     - a renamed pipeline stage, and opportunities moved to Won or to a later stage;
     - a calendar with availability rules, three appointments (one cancelled), and a task;
     - an inbox conversation with an internal note (the conversation, inbound message and review are seeded through admin SQL, as in the other acceptance tests);
     - a logo uploaded through the Storage API.
   - Harbor also has an employee with a permission override (`contacts.delete` granted). Ridge has a pending admin invitation.
2. **Export.** Every exported table is written to one JSON file, alongside `manifest.json`, which records:
   - row counts and SHA-256 digests;
   - sequence values;
   - the schema migration versions;
   - the list of Storage objects.

   Storage object files are copied out of the storage container.
3. **Checks on the export:**
   - Stack A's data is unchanged: every table's digest after the export matches its digest before.
   - No retained file contains any of the following:
     - a JWT, a bcrypt hash, or the service, anon or JWT-secret keys;
     - any user's password or access token;
     - the raw pending invitation token;
     - a refresh-token field.
4. **Stack B (target)** starts as a separate fresh stack on ports offset by 2000, with its own Docker project and volumes. It is checked to be empty and on the same migration versions. The export is restored into it, and Stack A is never written to.
5. **Checks on B's data:**
   - Every restored table has the same digest as the source, row for row.
   - Every sequence has the same value.
   - B contains no sessions, no MFA factors, and no integration secrets.
6. **Functional checks on B**, after each restored user is given a new B-only password through the local Auth admin API. Each user signs in to a separate app instance pointed at B. For each business:
   - Workspace separation holds:
     - the owner sees only their own business in the app;
     - the other business's contacts return 404;
     - a user-scoped PostgREST query for the other workspace returns no rows, so row-level security is enforced with the user's own JWT;
     - the other business's logo is private.
   - Settings and the AI receptionist greeting match the source.
   - Pipeline stage IDs and names match exactly, including the renamed stage. The won and moved opportunities point to the same stage IDs.
   - Each appointment appears exactly once, on its original calendar ID, at the original instant, and the cancelled one is still cancelled.
   - The overlap rule still holds: booking over a restored appointment returns 409 `overlap`, while the cancelled slot can be rebooked.
   - The audit history visible to the owner is at least as long as it was on A.
   - The logo bytes are identical.
   - New records can be created; sequences continue past the restored values.
   - The employee is still on the Harbor team, and the restored override still lets them delete a contact.
   - The employee's old password from A does not work on B.

## What is restored

- **Auth:**
  - `auth.users`, with password hashes and every pending confirmation, recovery, email-change, phone-change and reauthentication token blanked;
  - `auth.identities`.
- **App data:** every base table in the `public` and `private` schemas except `public.integration_secrets`. This covers:
  - workspaces, memberships, roles and permission overrides;
  - invitations (only the token hash is stored);
  - settings and the AI receptionist configuration;
  - contacts, tags and notes;
  - pipelines, stages and opportunities;
  - calendars, availability, appointments and tasks;
  - conversations, messages and reviews;
  - activity events and the workspace audit log;
  - platform tables.
- **Storage:** `storage.objects` rows (and `storage.prefixes` rows, when that table exists) for the `workspace-assets` bucket, plus the object files themselves. The bucket and its policies come from the migrations.
- **Sequences:** values for the `public` and `private` schemas.

The restore runs as one transaction as the database superuser, with triggers suspended (`session_replication_role = replica`). As a result:

- rows are restored exactly as exported;
- no restore-time audit or activity rows are invented;
- the `updated_at` triggers do not rewrite timestamps.

Rows already created by the target's migrations (reference data) are left in place, and the digest check confirms they are identical to the source.

## What is deliberately not restored (limitations)

- **Passwords, sessions and refresh tokens.** Every restored user has to set a new password (password reset) before signing in. In the rehearsal, the test sets them through the local Auth admin API.
- **MFA factors.** Platform admins must enroll MFA again before they can reach AAL2 platform functions.
- **Integration secrets** (`public.integration_secrets`). These must be re-entered on the integrations page.
- **Auth's own audit log, one-time tokens, flow state and SSO/SAML configuration.** These are excluded.
- **Pending invitations.** Their token hashes are restored, so the original link should keep working (the rehearsal does not exercise accepting one on the restored stack). The raw token itself is never part of the export.
- **Schema.** The rehearsal does not restore it. The target must be migrated to the same versions first; the restore checks this through `manifest.json`.
- **Scale.** The rehearsal uses small synthetic data and a JSON export. It is not a tool for large or production datasets.

## Hosted explicit backup and restore (staging rehearsal, 2026-11-02)

A plan-independent backup of a hosted project: an explicit database export plus a separate Storage export, restored into a separate, empty, disposable environment. It needs no paid plan. Rehearsed on the staging project with synthetic data only.

- Test: `tests/staging/backup-restore.test.ts` (not part of any suite; guarded by `tests/staging/env.ts`, refuses the production ref and non-synthetic workspaces).
- Result: **PASS 5/5**. The export took about 44 s, and the restore took about 57 s, including starting the target stack. 46 tables and about 10,000 rows matched by md5. The catalogs matched: 58 policies, 42 RLS flags, 46 relation owners, 94 functions (owner, `security definer`, `search_path`, ACL and source), 625 table grants, 95 triggers, schema and default privileges, four role settings, the bucket, and 27 migration-history rows.

### Procedure

1. **Database export** (Supabase CLI; it runs `pg_dump` in Docker over the direct connection):
   - `supabase db dump --db-url <url> --role-only -f roles.sql` contains role settings, including M21's `pgrst.db_pre_request` on `authenticator`.
   - `supabase db dump --db-url <url> -f schema.sql` contains the `public` and `private` schemas: tables, functions, policies, triggers, ownership and grants.
   - `supabase db dump --db-url <url> --data-only --use-copy -f data.sql` contains the rows of `auth`, `public`, `private` and `storage` (Storage metadata only, not the files).
   - `supabase db dump --db-url <url> --schema supabase_migrations -f history_schema.sql`, then the same command with `--data-only --use-copy` into `history_data.sql`. Together they hold the migration history.
2. **App objects on Supabase-owned tables.** `db dump` leaves out the app's policies and triggers on `storage.objects` and `auth.users`, because it skips those schemas. On staging that meant six objects:
   - the four `workspace_assets_*` Storage policies;
   - `workspace_assets_audit_grant_write`;
   - `on_auth_user_created_profile`.

   Export them to `managed.sql` from `pg_policies` and `pg_get_triggerdef`. Without this step, a restored project has no Storage access rules and no audit or profile triggers.
3. **Storage files.** Download every `workspace-assets` object through the Storage API with the service key, recording each file's sha256. A database backup never contains Storage files.
4. **Restore into a separate, empty project, in one transaction:**
   1. Apply `roles.sql`. Skip, and record, any statement that names a platform role the target lacks (on staging that was one grant to `supabase_realtime_admin`).
   2. Apply `schema.sql` and `history_schema.sql`.
   3. **Reconcile privileges.** Revoke all from `anon`, `authenticated` and `service_role` on every table, sequence and function in `public` and `private`, then re-apply the dump's own `GRANT`/`REVOKE` lines. Without this step, the target's default privileges widen access: the rehearsal found 40 functions newly executable by `anon` and 558 extra table grants. RLS still guarded the rows, but a restore must not widen access.
   4. Load `data.sql` and `history_data.sql` with `session_replication_role = replica`.
   5. Apply `managed.sql`.
5. **Storage files:** put each file back, under its original object version, into the target's Storage. Then compare the sha256 values.
6. **Verify:** compare row digests and catalogs with the source. Sign in with an original password and the original authenticator code, which gives AAL2. Confirm that RLS returns only the user's own workspace, that the private logo is readable by its owner and refused to anonymous callers, and that source-issued tokens are rejected because the target has a different signing key.

### What this covers, and its limits

- **Restored:** Auth users with their password hashes, identities, MFA factors (TOTP secrets), app data, ownership, policies, grants, triggers, role settings, migration history, Storage metadata, and the files.
- **Not usable after restore:** sessions and refresh tokens, because the target signs with a different key, so everyone signs in again. `public.integration_secrets` holds only ciphertext. It can be decrypted only with the same application key, so keep that key with the backup or re-enter the secrets. No app code writes this table yet, and it was empty on staging.
- **Sensitive export:** the dump holds password hashes and MFA secrets. Store it encrypted with restricted access, and delete it on schedule. The rehearsal kept it in the OS temp directory and deleted it.
- **The rehearsal target was a local disposable stack, not a second hosted project.** The Free plan allows two active projects, and both are in use: production and staging. A hosted target can differ in Supabase-managed details, such as platform-only roles and the Auth and Storage schema versions. A restore into a disposable hosted project, or into a branch, needs either a plan with room for one or pausing a project, so it is a decision for George.
- **Point in time:** the export is a consistent snapshot of each dump step, not point-in-time recovery. Writes made between the dump steps or after the export are lost. For production, stop writes during the export (maintenance window), or accept that loss.
- **Not a managed backup:** nothing runs on a schedule. A scheduled job, its storage location and its retention would need to be set up and approved.

## Production

Two options, decided by George before any spending:

1. **Explicit backup (no plan change):** the hosted procedure above, run against production during an approved write freeze just before cutover, with the encrypted export stored off-platform. It requires the production database connection string (a credential) and George's approval to read production data.
2. **Managed backups or point-in-time recovery (paid plan, D5):** Supabase's daily backups or point-in-time recovery, restored into a new project. Managed backups do not include Storage files, so step 3 above is still needed.

Either way, the restore checks above apply. No production data, hosted production project, or managed backup was touched in either rehearsal.

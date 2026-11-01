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

## Production

Production recovery should use Supabase's managed daily backups or point-in-time recovery, restored into a new project. The same checks then apply:

- migration versions match;
- users reset their passwords;
- platform admins re-enroll MFA;
- integration secrets are re-entered;
- the functional checks above are repeated with a test account.

No production data, hosted project, or managed backup was touched in this rehearsal.

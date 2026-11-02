# Production release plan (proposal — not approved, not executed)

Status on 2026-11-02: the authorized staging gates are complete (`docs/STAGING_CUTOVER_CHECKLIST.md` §1). **Production is not ready.** Its gates (§7) need George's decisions and approvals first. Nothing in this plan has been run against production. The only production access so far was reading project metadata (name, region and organization) with George's authorization.

## 1. Identities

| Item | Value | Source / confidence |
| --- | --- | --- |
| Production Supabase project | "fna-business-dashboard", ref `rbghfpwbwmrjbpjswbbn`, `us-east-1`, ACTIVE | Metadata read with authorization (2026-11-02) |
| Organization | Fortune&Finance (`qrmawcinoleswjhiuukr`), Free plan; two active projects (production and staging) | Metadata read |
| Other project in the organization | "Fortune&Finance Academy", INACTIVE (paused); not part of this release | Metadata read |
| Staging | `fna-staging`, same organization and region, Free plan; ref in the runbook | Created 2026-11-02 |
| Production web deployment | **Unknown.** The repository has no Vercel link (`.vercel`), and no Vercel metadata was read. Expected to serve `release` @ `9c189f8` (pre-P7, legacy auth, GHL webhooks). | Must be confirmed: check P2 |
| Candidate release build | branch `feat/native-multi-tenant`, final commit recorded in the handoff | Local |

## 2. Read-only preflight (needs approval P1; reads metadata and schema, never row contents)

Supabase production. These checks need the production database connection string, which is a credential: George supplies it to the operator's environment, and it is never written to a file.

1. Project status, PostgreSQL major version, plan, and the backup or point-in-time-recovery options available.
2. `supabase migration list --db-url …` and `select version, name from supabase_migrations.schema_migrations`, if that table exists.
3. Whether the legacy tables exist, and their structure (`\d public.sync_*`, `\d public.auth_sessions`), compared with the two legacy files. Row counts only, with no contents.
4. Existing objects that would collide with the manifest: `public.workspaces`, the `private` schema, the `workspace-assets` bucket, role settings on `authenticator`.
5. Auth configuration (`/auth/v1/settings`): sign-up disabled, email confirmation, TOTP enabled, site URL and redirect URLs set to the production origin. Number of existing Auth users.
6. Advisors (security and performance), as on staging.

Vercel production (George reads these, or approves read-only access):

7. Project and team, production branch, current production deployment with its commit, domains, and Deployment Protection.
8. Production environment variable **names** only. Look for `AUTH_PROVIDER`, `AUTH_SECRET`, `AUTH_OWNER_*`/`AUTH_ADMIN_*`/`AUTH_CLIENT_*`, `CLIENT_CONFIG_PATH`, `GHL_PIPELINE_ID`, `GHL_LOCATION_ID`, other `GHL_*`, `SUPABASE_*` and `APP_ORIGIN`.

GHL (George, in the GHL UI):

9. Which workflows post to the production `/api/webhooks/ghl` endpoint, and whether anything else relies on the legacy snapshot being current.

## 3. Migration-history reconciliation (production, as rehearsed)

Follow `docs/MIGRATION_VERSION_MAPPING.md` using the finding from step 2.3:

- History row `20260917` present: `migration repair --status reverted 20260917`, then `--status applied 20260917121316 20260917185155`.
- No history rows, legacy tables present (most likely, since the files say "apply manually"): `migration repair --status applied 20260917121316 20260917185155`.
- Legacy tables absent: `db push` applies both files.

Then run `supabase db push --dry-run` and confirm it lists exactly M1–M14 and M16–M26 (`STAGING_CUTOVER_CHECKLIST.md` §5), never M15. Then run `db push`, then `migration list`; local and remote must match. Afterwards verify M21 (`pgrst.db_pre_request` on `authenticator`), M14 (legacy tables closed to `anon`/`authenticated`), RLS on every public table, and no Realtime tables.

The legacy deployment keeps working during and after the push: it reads `sync_*` and `auth_sessions` with the service role, which M14 does not affect (stack test "legacy tables are closed to anon and authenticated, open to the service role"). No native object is used by legacy mode.

## 4. GHL webhook dependency and legacy settings

- A P7 build has no `/api/webhooks/ghl`. Once it is promoted, every GHL workflow that still posts to the endpoint gets 404, and the legacy snapshot stops updating. Before promotion, disable those workflow webhook actions (or confirm in step 9 that none exist). Native mode never contacts GHL.
- Keep until T6, so that `AUTH_PROVIDER=legacy` remains a rollback: `AUTH_SECRET`, `AUTH_OWNER_*`, `AUTH_ADMIN_*`, `AUTH_CLIENT_*`, `AUTH_FAIL_CLOSED`, and `GHL_LOCATION_ID` (legacy snapshot only).
- No longer read by any build from P7 onward: `CLIENT_CONFIG_PATH` and `GHL_PIPELINE_ID`. If step 8 finds them, they are inert. Remove them after T6 rather than at cutover, so the rollback build sees an unchanged environment.
- Add for native mode: `AUTH_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), and `APP_ORIGIN` (the production origin). Switch `AUTH_PROVIDER` only after George's platform-admin bootstrap and MFA (§6).

## 5. Backup and rollback

Backup before the push (decision P3):

- **Option A, no spending:** the explicit hosted backup (`docs/BACKUP_RESTORE_REHEARSAL.md`, hosted section, rehearsed 5/5 on staging), run against production during a short write freeze. The encrypted export is stored off-platform with restricted access. It covers Auth (password hashes and MFA factors), app data, ownership, policies, grants, triggers, role settings, migration history, Storage metadata and files. It does not give point-in-time recovery.
- **Option B, paid (D5):** managed daily backups or point-in-time recovery. Storage files still need the explicit file export.
- With either option, restoring into a disposable hosted target needs a free project slot (pause one project, or a plan with room for one). The staging restore went into a local stack (limitation recorded).

Rollback, from least to most invasive:

1. **Application:** set `AUTH_PROVIDER=legacy` and promote the previous production deployment (`release` @ `9c189f8`, or whatever step 7 finds). Re-enable the GHL webhook actions if they were disabled. This works because the native schema is additive, legacy tables and data are untouched, and the legacy credentials are kept.
2. **Data written in native mode:** export it (explicit procedure) before rolling back, if real records were created.
3. **Database:** leave the native schema in place; it does not affect legacy mode. `supabase/rollback/…down.sql` is rehearsed on staging only and is **not planned for production**. Restoring the pre-push export into a new project is the last resort.

## 6. Real F&A provisioning (T3): production, not staging

Provision the real F&A business on production only, after the migrations, George's bootstrap and MFA. Doing it on staging would:

- put real business and owner data in an environment with weaker controls (Free plan, no managed backups, test tooling with service-role access);
- not carry over to production;
- break staging's rule that every workspace is synthetic. The staging harnesses refuse to run when a non-synthetic workspace exists.

The same flow has been exercised on staging with synthetic stand-ins in rehearsal journeys 2–3.

This needs approval P5 and the following data from George:

- display name;
- slug, and provisioning key `fa-live`;
- owner email (George's);
- time zone and business hours;
- support email and phone;
- website, booking link and review link;
- logo file.

It also needs one decision: native mode starts empty, and no importer exists from the legacy `sync_*` tables. Is starting empty acceptable, or is an import project needed (not built)?

## 7. MFA recovery policy (proposal for George's approval — no bypass is enabled)

Current state: George is the only platform admin. `bootstrap-platform-admin.ts remove-mfa` deletes the factors and writes start and outcome audit records. There are no recovery codes, no AAL1 path to platform functions (M26), and no self-service reset.

1. **Authorized operators:** a named list approved by George. Proposal: George, plus one named second platform admin enrolled with MFA. Nobody may run recovery on their own account. If the only admin is the one who lost the device, recovery is run by the named technical operator who holds the service key, under the identity checks below.
2. **Identity verification, all three required:**
   - the request is confirmed by a call back to a phone number recorded in advance (not one given in the request);
   - a one-time code is sent to the account's email on file;
   - a live video check by the operator.

   Requests arriving only by email or chat are never sufficient. Record a ticket reference.
3. **Execution:**
   1. `remove-mfa --email … --env production --reason "<ticket ref>"`.
   2. End every session for that user at once. With M21, access requires a live Auth session row, so deleting the user's `auth.sessions` rows ends access immediately. Proposed tooling, **not built**: `remove-mfa --end-sessions`, which writes its own audit record.
   3. If the device may be compromised, also force a password reset.
   4. The user re-enrols at `/platform/mfa`. Until then, platform functions stay unavailable (AAL2 required).
4. **Audit trail:** the existing `remove-mfa` start and outcome records in the platform audit log, with the ticket reference. The operator emails every platform admin and the affected user after each recovery. Keep a recovery log in the runbook.
5. **Recovery testing:** before production, and then quarterly, rehearse on staging with a synthetic admin: enrol, remove, check that sessions ended, re-enrol, and confirm the audit rows. The local proof is `tests/supabase-stack/bootstrap.test.ts`.
6. **Explicitly excluded:** recovery codes, email-only MFA reset, any AAL1 fallback, and shared admin accounts.

## 8. Approvals requested (consolidated)

| # | Request | Needed for |
| --- | --- | --- |
| P1 | Read-only production preflight (§2 steps 1–6): George provides the production connection string to the operator's environment; schema and metadata only, no row contents. | Reconciliation plan |
| P2 | Vercel production identity and env-var **names** (§2 steps 7–8), read by George or through read-only access. | Rollback target and legacy settings |
| P3 | Backup choice: A (explicit export plus write freeze, $0) or B (paid plan, D5). Optionally free a project slot for a hosted-target restore test. | Pre-push backup |
| P4 | GHL: disable the workflow webhook actions at cutover (§4), or confirm none exist. | Promoting a P7 build |
| P5 | Provision real F&A on production (§6), with the listed data and the "start empty" decision. | T3 |
| P6 | MFA recovery policy (§7), including the named second operator and whether to build `--end-sessions`. | Production operations |
| P7 | Leaked-password protection (Pro plan setting; Supabase advisor). Accept it as off, or enable it with D5. | Auth hardening |
| P8 | The cutover itself: maintenance window, migration push, `AUTH_PROVIDER=supabase`, promotion. | T5 |

## 9. Ordered release checklist

1. George approves P1–P7, and staging sign-off.
2. Read-only preflight (§2); record the findings and the reconciliation finding.
3. Freeze writes; take the backup (P3) and verify the export's digests.
4. Reconcile migration history, `db push --dry-run`, `db push`, verify M14, M21, RLS and Realtime (§3).
5. Bootstrap George as platform admin; enrol MFA.
6. Provision F&A (`fa-live`) and accept the owner invitation (§6).
7. Disable the GHL webhook actions (P4); set the native env vars, keeping the legacy ones; set `AUTH_PROVIDER=supabase`.
8. Promote the release build (P8); smoke-test with MFA login, every page, and `/api/health` reporting `authProvider: "supabase"`.
9. Keep rollback ready (§5) for 14 days; then T6, then M15 with a verified backup (separate approval).

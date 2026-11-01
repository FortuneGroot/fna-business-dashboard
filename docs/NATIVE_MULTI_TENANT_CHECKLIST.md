# Native Multi-Tenant — P1–P7 Checklist and Local Acceptance

Companion to `docs/NATIVE_MULTI_TENANT_SPEC.md` (§14 decisions, §15 P1 record, §16 P2 record, §17 P3 record, §18 P4 record, §19 P5 record, §20 P6 record, §21 P7 record, §22 local acceptance). Staging/cutover steps: `docs/STAGING_CUTOVER_CHECKLIST.md`.
Status as of 2026-11-01. Branch `feat/native-multi-tenant`, committed locally only; nothing pushed or deployed.
**Stop point: P1–P7 done and rehearsed locally (§22); waiting for independent review. With `AUTH_PROVIDER=supabase`, pages read each workspace's own records; Settings manages the team, invitations (links shown once; nothing sent), workspace profile, AI receptionist settings (stays off), and integrations (read-only); Contacts, Opportunities, Calendars, Tasks, and the inbox (internal notes only) create and edit native records. The platform console (P6) at `/platform` requires a listed platform admin with an AAL2 session (MFA through the app), provisions workspaces, replaces bootstrap owner invitations, suspends/reactivates, grants time-limited audited support access, and shows the audit log. P7 retired the GHL runtime: no webhook ingestion, CRM client, per-client configuration, or `GHL_*` settings remain on any native path; legacy mode (default) keeps its login and shows a read-only snapshot of the last synced activity. The full local acceptance rehearsal passed (16 journeys, two synthetic businesses, fresh disposable stack). Next: staging (P8) only with approval, after the open decisions below.**

Legend: `[x]` done and verified locally · `[ ]` not done · **BLOCKED** cannot be verified on this machine (never counted as passed).

## Binding decisions

- [x] Preserve the existing theme and navigation (sidebar items, order, labels, routes, layout, colours). P1 changed no UI files.
- [x] Workspaces architecture only. Conflicting `organizations` SQL is rejected; `tests/db/security-findings.test.ts` fails if any migration mentions `organizations`, `organization_id`, or `org_id`.
- [x] George = platform super-admin **and** F&A workspace owner (platform flag via bootstrap script; ownership via the F&A owner invitation). Legacy users get no automatic membership.
- [x] Support phone 781-964-0654 recorded (code change in `src/lib/brand.ts` deferred to the UI phase).
- [x] TJ Towing / Vinny Moving are synthetic fixtures only (`TJ Towing (synthetic)`, `Vinny Moving (synthetic)`, `example.test` emails).
- [x] D1–D7 resolved as instructed by the GC (spec §14): D1 local Docker + Supabase CLI; D2 config + exactly 12 stages, no calendars/business records; D3 lead intake later phase; D4 separate staging project later; D5 paid Supabase before cutover, no purchase; D6 as above; D7 as above.

## P1 security review findings

- [x] 1. Legacy `sync_*` / `auth_sessions` preserved; anon/authenticated revoked; default-deny RLS; service role retained (M14).
- [x] 2. Owner-affecting membership changes serialize on a workspace lock taken before mutation; last-owner rechecked under the lock. Concurrent removals tested on real local PostgreSQL with independent sessions (plus negative control).
- [x] 3. Nested PGlite sessions rejected immediately; per-session timeout; `--test-timeout` on every suite.
- [x] 4. Audited, platform-only bootstrap invitation rotation for workspaces that never had an owner; previous tokens revoked in the same transaction.
- [x] 5. Note/message authors: active member or live platform write grant, with actor and grant attribution; assignees still require membership.
- [x] 6. Actor attribution columns database-controlled; forged values rejected (no grant) and stamped from `auth.uid()`.
- [x] 7. Same-workspace composite FKs for audit `grant_id` and author `author_grant_id`.
- [x] 8. Clients cannot mark integrations verified/connected; AI receptionist enablement blocked by constraint until trusted verification and a runtime exist.
- [x] Regression tests for every finding.
- [x] `npm test` runs unit + database + concurrency + real-stack suites and fails on failed, cancelled, skipped, or missing tests.

## P1 verification round

- [x] Diff reviewed (no secrets; only intended files); P1 committed locally (`a1fe8b3`), not pushed.
- [x] VC++ 2015-2022 x64 redistributable installed (official winget package); Edge workaround removed.
- [x] Supabase CLI 2.122.0 installed (exact-pinned devDependency); `supabase/config.toml` created.
- [x] WSL 2.7.14 and Docker Desktop 4.97 installed.
- [x] Docker engine running (29.9.2; virtualization enabled).
- [x] Legacy migration versions made unique and ordered; mapping in `docs/MIGRATION_VERSION_MAPPING.md`; enforced by test.
- [ ] Remote migration history reconciled — cutover prerequisite (history unknown; no blind repair).
- [x] Real-stack suite (`tests/supabase-stack/`, 17 tests) run on a disposable stack: 17/17 PASS after decision A (members-only Storage writes); the earlier run was 15/17 (R2-3).

## Second review (Codex) findings

- [x] R2-1 (P1): authority re-checked immediately after the workspace lock in every membership RPC; demotion-versus-promotion race reproduced and refused on real PostgreSQL (with negative control).
- [x] R2-2 (P2): runner keeps real failures FAIL even when output contains `BLOCKED:` (per-root-cause classification; fixtures).
- [x] R2-3 (P2): platform-granted Storage mutations audited (actor, workspace, grant, operation, object path); Storage policy isolation covered on shim tables.
- [x] R2-4 (P2): stack suite resets only an isolated, explicitly disposable project it started (guards unit-tested).
- [x] Storage policies through the real Storage API — PASS.
- [x] R2-3 through the real Storage API — reopened (the Storage API commits row writes as `service_role` without the caller's identity), then resolved by decision A: Storage writes require active membership plus `settings.write`; platform grants keep read access only.
- [x] Audited server endpoint for platform Storage changes — delivered in P2 (`/api/platform/workspace-logo`, service-role allowlist A5, M16 RPCs).

## Second review coverage follow-up

- [x] Real (clock-driven) grant expiry: real PostgreSQL, grant row untouched.
- [x] Storage update/upsert; Storage access after grant revocation, member removal, and suspension (PGlite).
- [x] Permission overrides: RLS, RPCs, Storage, workspace scoping, promotion/removal clearing, who may set them, audit (PGlite); override races (real PostgreSQL).
- [x] Concurrent provisioning, invitation acceptance/revocation, and bootstrap rotation (real PostgreSQL).
- [x] Contact-write audit asserts the exact action, actor, and target (PGlite and stack suite).
- [x] The same coverage through GoTrue/PostgREST/Storage — PASS, except the two Storage-audit tests (R2-3).

## P2 authentication

- [x] `AUTH_PROVIDER` flag: `legacy` (default, unchanged behaviour), `supabase`; any other value fails closed (503 / login error).
- [x] Server-only Supabase config (`SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY`); no `NEXT_PUBLIC_*`; httpOnly, SameSite=Lax cookies (Secure in production).
- [x] Middleware: `getClaims()` first; 307 to `/login?next=` for pages, 401 JSON for APIs; `fna_session` never read in supabase mode (ISO-F4).
- [x] Middleware decides workspace access and §4.3 page permissions before rendering (fix for a page-content leak found by the first real-stack run; §16.2).
- [x] Request context from `rpc request_context` with the user's own JWT; §7.1 error codes.
- [x] Login/logout/me in supabase mode; generic invalid-credentials answer; 429 `rate_limited`; outages 503.
- [x] `/api/workspaces` list and `/api/workspaces/active` switch (403 for workspaces you cannot use, 422 for invalid ids).
- [x] `/no-access` and `/workspace-suspended` in the existing card design; Sidebar Setup/Resources by permission; design unchanged.
- [x] Audited platform Storage endpoint (R2-3) with service-role allowlist entry A5; M16 migration and rollback.
- [x] Static guards: SR-1 service-role allowlist, ISO-F1 (no client-supplied workspace id except the switch route), no cross-request client state, AAL1 override never enabled.
- [x] Wire pages and APIs to workspace data — done in P3 (below); Settings rewrite remains P4.
- [x] `/platform` console (P6, below); `/no-access` sends AAL2 platform admins to `/platform` and offers listed AAL1 admins the MFA step.
- [x] Review finding 1: Storage audit outcomes are server-only (`claimed`/`finished` execute as `service_role` only; outcome derived from Storage; unclaimed requests never complete).
- [x] Review finding 2: completion errors handled (retries, `503 audit_pending`, `409 change_pending`, `POST` recovery by the requesting admin).
- [x] Review finding 3: refreshed/cleared session cookies applied on `/api/auth/me` and every other supabase-mode response, including denials.
- [x] Review finding 4: JSON bodies must be objects with typed fields on all new endpoints (null, arrays, wrong types → 400/422).
- [x] Review round 3: Storage audit outcomes are attributed to the server's own operation (secret per-operation token, `storage.objects` trigger; the Storage API commits member and server writes identically, so the token is the discriminator); member writes never count; recovery returns `409 operation_in_progress` and keeps the claim while the operation may run; after the 2-minute lease, recording the outcome fences any late write.
- [ ] Decision (recommended by Codex before real use): make logout immediate for reads (session-row check in `request_context`). Today, per spec §5.1, a copied cookie of a logged-out session reads until its access token expires; sensitive mutations already refuse it.

## P3 read parity

- [x] Data layer `src/lib/data/`: user-JWT reads only, active-workspace filter on every query plus RLS, soft-deleted rows excluded, 500-row list cap, exact counts, pipeline value paged past `max_rows`.
- [x] `/api/dashboard/*` keep the pre-migration shapes (API-1) with the §7.3 read permission per endpoint; 503 `unavailable` on read failure; `private, no-store`.
- [x] `/api/tenant/config` from the workspace (owner block needs `settings.write`); `/api/tenant/public` platform-only; `/api/health` checks the database in supabase mode.
- [x] Retired single-tenant endpoints (`/api/sync/health`, `/api/onboarding/readiness`, `/api/events`, `/api/ghl/health`, `/api/leads`) answer 404 `not_available` in supabase mode, closing the path by which other workspaces could read F&A's sync store.
- [x] All pages read through `getPageData()`; native copy has no sync/CRM wording; legacy copy unchanged; layout unchanged.
- [x] ISO through the app: workspace B never receives workspace A's ids, names, or workspace id from any API or page (real stack).
- [x] UI-1: 19 routes 200 with no page errors for the owner, seeded data rendered; admin Setup redirect, Resources visible; native empty states.
- [x] UI-2: local harness; sidebar identical on all 20 pages; differences are copy (§17.4).
- [x] Review fix: calendar cards match bookings by calendar id with no fallback; pipeline columns match by stage id with exact per-stage totals (§17.5).
- [x] `/api/webhooks/ghl` retired in P7; the remaining legacy service-role readers (`legacy/rest-client`, `legacy/rest-auth`, legacy session store/edge) are legacy-mode only and retire at T6 (spec §21.3).

## P4 team and settings

- [x] `/api/team` list, role change, overrides (atomic, API only), removal — through the M11 RPCs with the caller's JWT; role authority, self-change, last-owner, and post-lock checks unchanged.
- [x] Invitations: link returned once (hash stored only), list, revoke; public preview with masked email; acceptance signed in (email must match) or by creating the invited address's account (A1, email from the database); expired/used/revoked 410, mismatch 403, existing account 409.
- [x] No email or SMS on any path; NET-1 guard on the app process; disposable stack config has no SMTP/SMS route.
- [x] Workspace settings (`settings.read`/`settings.write`), strict validation, database attribution, audit of changed field names only.
- [x] AI receptionist settings; cannot be enabled by any client; escalation must be an active member.
- [x] Integrations list without secrets; status and verification server-controlled.
- [x] Native onboarding checklist from real records (`onboarding.read`).
- [x] Settings UI in the existing cards; invite landing page in the existing card design.
- [x] Browser flow against the real local stack (invite → account → role change → removal → settings → revoked link).
- [ ] Overrides editor in Settings (API exists).
- [ ] Logout-replay decision (above) still open.

## P5 native records

- [x] M18: atomic `save_contact`, `save_calendar`, `replace_availability` (security invoker, caller's JWT) and activity events with actor and changed field names only; rollback block.
- [x] Contacts: create, edit, detail, notes, soft delete (owner/admin, audited), multi-word search, tag filter, keyset pages, exact totals.
- [x] Opportunities: create, edit, move by stage id, soft delete; exact cents; won/lost and `closed_at` from the stage.
- [x] Calendars: create/edit, member assignment, weekly availability; appointments create/reschedule/status with overlap refused (also under concurrency).
- [x] Tasks: create/edit, assignment to active members only, status changes, exact counts.
- [x] Inbox: conversation and message reads with paging; internal notes only; no send path; NET-1 still empty.
- [x] Cross-workspace references and removed assignees refused (422); other workspaces' ids 404; client workspace ids ignored.
- [x] UI in the existing pages, cards, tables, and modals; legacy mode renders the original pages (original inbox kept verbatim).
- [x] Browser flow against the real local stack (contacts, opportunity to Won, calendar and booking with overlap error, task done, inbox note).
- [ ] Board edits limited to the 8 opportunities shown per column; no delete for appointments/tasks (cancel/complete instead).

## P6 platform console

- [x] M19: `platform_status`, search/detail/grants/audit pages, reason-bearing `platform_revoke_access(grant, reason)` (live grants only; one-argument form no longer client-callable); rollback block.
- [x] Console outside the client sidebar (existing top bar, cards, tables, modals); legacy mode 404.
- [x] Platform authority = `platform_admins` row + AAL2, independent of membership; members 403/404, listed AAL1 admins `mfa_required` and redirected to MFA; decided in middleware before rendering.
- [x] MFA enrolment and verification through the app (TOTP via the user's own Supabase session); AAL2 cookies; wrong codes 422.
- [x] Provisioning: transactional, idempotent, concurrent-safe; owner link shown once; nothing emailed.
- [x] Bootstrap owner invitation replacement with reason; old link revoked; refused once an owner joined.
- [x] Suspension/reactivation with reason; members 423; read grants read; write grants no access; new write grants 423.
- [x] Support access: mode, duration (1–480 min), reason; banner with workspace, mode, expiry, minutes left; ending needs a reason; revocation and clock expiry apply on the next request; writes attributed to the grant.
- [x] Audit view (all workspaces or one) with actor email and reason; credential-like metadata keys dropped; no tokens in any response except the one-time link.
- [x] Browser flow against the real local stack (no-access → MFA enrolment → provision → detail → support access → banner → end → audit).
- [ ] MFA device-loss recovery is not self-service (operator removes the factor); no recovery codes.

## P7 GHL runtime retired

- [x] §8.3 files deleted (CRM client, mapping, Master guard, leads, env, sync store and ingestion, onboarding readiness, deployment validation, tenant config, retired routes, custom CSS, client scripts, `config/`); recoverable from Git.
- [x] GHL-era docs archived under `docs/archive/` with an index and rollback note; README and release policy rewritten.
- [x] Native mode loads no legacy module (dynamic imports inside legacy branches only; static test).
- [x] Legacy mode: read-only `sync_*` snapshot (GET/HEAD only, partition-filtered, Master refused), F&A identity equal to the pre-P7 defaults, D7 phone applied.
- [x] Retired routes 404 in both modes; middleware lists cleaned; `.env.example` and npm scripts have no retired settings or scripts.
- [x] GHL-1 / GHL-2 pass with an exact, test-enforced exception list (the two legacy snapshot files; `GHL_LOCATION_ID` as the legacy partition) — spec §21.3.
- [x] Build and run without GHL variables; browser bundles free of CRM terms, partition ids, and secrets; NET-1 empty.
- [x] Defect fixed: Settings fetched `/api/health` without reading it, which left the page loading in Chromium (UI-2).
- [ ] Remaining dependency until T6/M15: legacy snapshot modules, legacy migration `20260917121316_sync_store.sql`, legacy session store/edge. Not removable before the approved cutover gates.
- [ ] Before promoting any P7 build: confirm production no longer expects live workflow webhooks, and that `CLIENT_CONFIG_PATH`/`GHL_PIPELINE_ID` are unused there (owner check; not accessed from here).

## Local acceptance rehearsal (spec §22)

- [x] Acceptance suite `tests/acceptance/` (`npm run test:acceptance`, minimum 16): provisioning, invitation acceptance, login/MFA, workspace switching, settings/team, all record types, overrides, malformed requests, concurrency, pagination, support grants, suspension, access removal, logout replay measurement, legacy mode, NET-1 and audit isolation — PASS 16/16 on a fresh disposable stack.
- [x] Defect fixed: JSON endpoints accepted valid JSON sent as `text/plain` (CORS-simple); `parseBody` and `readJsonObject` now require a JSON content type (422/400); unit regressions in `p5-crm` and `p2-auth`.
- [x] Defect fixed: legacy-mode `/platform` answered 200 (streamed `notFound()`); middleware now returns 404 before rendering; unit regression in `p6-platform`.
- [x] Staging/cutover checklist written without accessing staging or production (`docs/STAGING_CUTOVER_CHECKLIST.md`).
- [ ] Logout-replay decision — observed: replayed cookie read 200, record write 200, invitation 401.
- [ ] Migration-history reconciliation on staging.
- [ ] Platform-admin bootstrap script (spec §6.4 A2) not written; suites insert the row directly.

## Checks

| Check | Environment | Status |
| --- | --- | --- |
| `npm test` | runner (minimums: unit 241, db 217, realpg 28, stack 63, acceptance 16) | [x] final run in spec §22.4: unit 241/241, db 217/217, realpg 28/28, stack 63/63, acceptance 16/16 |
| `npm run test:db` | PGlite + Supabase shim | [x] PASS 217/217 |
| `npm run test:db:concurrency` | real local PostgreSQL 18.6, independent sessions (incl. Storage operation vs recovery races) | [x] PASS 28/28 |
| `npm run typecheck` (`tsc` for the app, then `tsconfig.tests.json` for test files) | — | [x] PASS (test files were not type-clean before P6: 44 errors in P4/P5 tests and one in `auth.test.ts`, fixed without changing assertions) |
| `npm run build` | Next.js 15.5.25 | [x] PASS |
| Lint | — | not available (no script) |
| `npm run test:stack`: CLI `db reset` applies all migrations | real Supabase local stack | [x] PASS |
| GoTrue sign-up → profile; forged/expired/unsigned JWT; AAL1 vs TOTP AAL2 | real Supabase local stack | [x] PASS |
| RLS isolation, forged attribution, revoked membership, suspension, platform grants | real Supabase local stack | [x] PASS |
| Storage bucket + policies, PUT/upsert, overrides, clock expiry, concurrency | real Supabase local stack | [x] PASS |
| Legacy tables closed to anon/authenticated over PostgREST | real Supabase local stack | [x] PASS |
| Platform write grants refused for Storage upload, PUT, upsert, delete; GET allowed; nothing audited | real Supabase local stack | [x] PASS (R2-3, decision A) |
| App (`next build` + `next start`, AUTH_PROVIDER=supabase) against real GoTrue: AUTH-1, session refresh, JSON body validation, logout replay (reads until token expiry; sensitive mutation refused), ISO-F3, ISO-F4, gates, MEM-1, SUSP-1, workspace switch, audited Storage endpoint (server-only outcomes, completion failure and recovery, recovery vs in-flight write, member write during a pending request, fenced late write) | real Supabase local stack | [x] PASS (11 tests) |
| App reads native data (P3): API-1 shapes and parity with the owner's PostgREST view, ISO through APIs and pages, tenant config/public, health, retired endpoints, UI-1, native empty states | real Supabase local stack | [x] PASS (5 tests) |
| P3 review fixes: pipeline columns and calendar cards by id | real Supabase local stack | [x] PASS (3 tests) |
| P4 team and settings: INV, ROLE, MEM, SUSP, SET-1..7, browser flow; NET-1 (no outbound connection, no SMTP/SMS route) | real Supabase local stack + Chromium | [x] PASS (10 tests) |
| P5 native records: CRUD-1..5, workspace switching, browser flow (NET-1 still empty) | real Supabase local stack + Chromium | [x] PASS (7 tests) |
| P6 platform console: CON-1..9 (denial, MFA, provisioning, rotation, search, grants, clock expiry, suspension, logged-out session, browser flow) | real Supabase local stack + Chromium | [x] PASS (10 tests) |
| P7 retirement: retired routes 404 (incl. webhook POST), employee owner-API 403 via `/api/audit`, app started without `GHL_*` | real Supabase local stack | [x] PASS (in the 63) |
| UI-2 visual diff against `docs/baseline/screenshots/` | disposable stack + built app + cached Chromium | [x] run after P7: all 20 routes 200; sidebar 0.00% on all 20 pages; other pages at their P3–P5 figures; Settings/Onboarding differ by P4 content (§21.5) |
| Acceptance rehearsal (16 journeys, two synthetic businesses; legacy mode on the same build) | fresh disposable Supabase stack + built app | [x] PASS 16/16 (twice) |
| Real Auth rate limiting observed | real Supabase local stack | not observed locally (40 failed sign-ins, none limited); 429 mapping unit-tested |

## Remaining blockers / before staging

- [ ] Reconcile legacy migration history on the staging project before any push (`docs/MIGRATION_VERSION_MAPPING.md`).
- [ ] Staging Supabase project (D4) and paid plan (D5) — later, by instruction.
- [ ] Logout-replay decision; platform-admin bootstrap script or approved manual step; MFA recovery; P7 deploy ordering — see `docs/STAGING_CUTOVER_CHECKLIST.md` §0.

## Not done by instruction

No production access, deployment, push, real invitations, outbound communications, or purchases. Authentication and data-layer changes are local and off by default (`AUTH_PROVIDER=legacy`); UI changes are the two access pages (P2), native copy in the existing layouts (P3), the native Settings cards and invite landing page (P4), native create/edit controls in the existing record pages (P5), and the separate platform console, MFA page, and support-access banner (P6). P7 removed only code, routes, scripts, synthetic configuration, and docs (archived); no table, migration, data, or private configuration was removed, M15 was not run, and legacy authentication stays until T6.

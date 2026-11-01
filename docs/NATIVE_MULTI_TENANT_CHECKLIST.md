# Native Multi-Tenant — P1 / P2 / P3 / P4 Checklist

Companion to `docs/NATIVE_MULTI_TENANT_SPEC.md` (§14 decisions, §15 P1 record, §16 P2 record, §17 P3 record, §18 P4 record).
Status as of 2026-11-01. Branch `feat/native-multi-tenant`, committed locally only; nothing pushed or deployed.
**Stop point: end of P4. With `AUTH_PROVIDER=supabase`, pages read each workspace's own records and Settings manages the team, invitations (links shown once; nothing sent), workspace profile, AI receptionist settings (stays off), and integrations (read-only); legacy mode (default) is unchanged. Create/edit of records (P5) is next.**

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
- [ ] `/platform` console (P6); platform admins without a workspace see `/no-access` meanwhile.
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
- [ ] `/api/webhooks/ghl` and legacy service-role readers retire in P7.

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

## Checks

| Check | Environment | Status |
| --- | --- | --- |
| `npm test` | runner (minimums: unit 257, db 197, realpg 28, stack 46) | [x] all four suites PASS: unit 257, db 197, realpg 28, stack 46 |
| `npm run test:db` | PGlite + Supabase shim | [x] PASS 197/197 |
| `npm run test:db:concurrency` | real local PostgreSQL 18.6, independent sessions (incl. Storage operation vs recovery races) | [x] PASS 28/28 |
| `tsc` (app and test files) | — | [x] PASS |
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
| UI-2 visual diff against `docs/baseline/screenshots/` | disposable stack + built app + cached Chromium | [x] run: sidebar 0.00% on all 20 pages; copy-only differences (§17.4) |
| Real Auth rate limiting observed | real Supabase local stack | not observed locally (40 failed sign-ins, none limited); 429 mapping unit-tested |

## Remaining blockers / before staging

- [ ] Reconcile legacy migration history on the staging project before any push (`docs/MIGRATION_VERSION_MAPPING.md`).
- [ ] Staging Supabase project (D4) and paid plan (D5) — later, by instruction.

## Not done by instruction

No production access, deployment, push, real invitations, outbound communications, or purchases. Authentication and data-layer changes are local and off by default (`AUTH_PROVIDER=legacy`); UI changes are the two access pages (P2), native copy in the existing layouts (P3), and the native Settings cards and invite landing page (P4).

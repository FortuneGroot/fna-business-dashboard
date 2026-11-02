# Native Multi-Tenant Migration — Technical Specification

Status: **P0 + P1 (database schema and isolation tests) and P2 (Supabase authentication behind `AUTH_PROVIDER`, default `legacy`) implemented locally on `feat/native-multi-tenant`, committed locally (not pushed), never applied to any hosted Supabase project or deployment. P1 findings resolved (§15); P2 record in §16. Real local Supabase stack suite, including the production build of the app signing in through real GoTrue, passes 28/28 on a disposable stack (§16.4); P2 review findings resolved (§16.5, §16.6). Data layer (P3+) and UI work not started; the existing design is unchanged.**
Branch: `feat/native-multi-tenant` (created from `release` @ `9c189f8`).
Scope: convert the single-tenant, GHL-fed dashboard into a native multi-tenant SaaS on Supabase while preserving every sidebar item, route, layout, and style, and the existing theme and navigation.

Hard constraints for all phases until explicitly lifted by George:

- No production changes, deployments, pushes, real invitations, or outbound communications (email, SMS, calls).
- Tests never target production. Test tooling refuses to run unless the database URL is local (`127.0.0.1` / `localhost`) or an explicitly allowlisted non-production project.
- Open authentication (`AUTH_DEV_OPEN`) is never enabled.
- Architecture is **workspaces only** (§1, item 14). Any SQL or design that introduces an `organizations` hierarchy, `organization_id`, or `org_id` is rejected; a test enforces this.
- Test fixtures are synthetic. "TJ Towing (synthetic)" and "Vinny Moving (synthetic)" are fixture names only, with `example.test` addresses; they are not real clients and no real client data is used.

---

## 0. Baseline (verified 2026-11-01)

### 0.1 Source control

| Item | Value |
| --- | --- |
| Base branch / commit | `release` @ `9c189f8` "Remove protected Master location ID from client bundles via server-only split" |
| Working branch | `feat/native-multi-tenant` (no commits yet; untracked: `docs/baseline/`, this file) |
| `origin/main` | Same code as `release` plus `PROJECT_INFO.md` and `VALIDATION_RESULT.json` |
| AGENTS.md | None in repo, parents, or user home |

### 0.2 Checks

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci --no-audit --no-fund` (lockfile, no upgrades) | Pass. 33 packages. npm 11 skipped `esbuild` postinstall (allowScripts); tests and build unaffected. |
| Unit tests | `npm test` | **Pass — 137 tests, 36 suites, 0 failures** |
| TypeScript | `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` | **Pass — 0 errors** |
| Lint | — | **Not available.** No ESLint config or `lint` script; `next lint` would prompt to install ESLint, which was not done. |
| Production build | `npm run build` (Next.js 15.5.25) | **Pass** — 40 routes + middleware (35.6 kB), no warnings |
| Static QA | `npm run qa` | **Not run** — `qa/run_static_audit.py` writes tracker files into `qa/` |
| Local DB / integration | — | **Not possible** — Docker, Supabase CLI, and `psql` are not installed |

### 0.3 Local runtime baseline

- Started with `next start -H 127.0.0.1 -p 3100` using a random local `AUTH_SECRET` and a throwaway local owner credential. No Supabase, GHL, or Vercel variables. `AUTH_DEV_OPEN` unset.
- Auth enforcement confirmed: unauthenticated `/dashboard` → 307 to `/login`; unauthenticated `/api/dashboard/summary` → 401; wrong password → 401; valid login → 200.
- Data source was the in-memory sync store, so every data surface shows its empty "Waiting for sync" state. This is the expected baseline without GHL.
- Note: with `AUTH_FAIL_CLOSED=true` and no Supabase, login succeeds but middleware rejects every session (no durable session row). This is correct fail-closed behaviour and is why the baseline ran without that flag.

Screenshots (1440×900 viewport, full page) are in `docs/baseline/screenshots/`:

| # | Route | Sidebar label | HTTP | JS errors |
| --- | --- | --- | --- | --- |
| 00 | `/login` | — | 200 | 0 (one expected 401 from `/api/auth/me` before sign-in) |
| 01 | `/dashboard` | Dashboard | 200 | 0 |
| 02 | `/inbox` | Conversations | 200 | 0 |
| 03 | `/contacts` | Contacts | 200 | 0 |
| 04 | `/pipeline` | Opportunities | 200 | 0 |
| 05 | `/calendar` | Calendars | 200 | 0 |
| 06 | `/tasks` | Tasks | 200 | 0 |
| 07 | `/automations` | Automations | 200 | 0 |
| 08 | `/marketing` | Marketing | 200 | 0 |
| 09 | `/reviews` | Reputation | 200 | 0 |
| 10 | `/payments` | Payments | 200 | 0 |
| 11 | `/reporting` | Reports | 200 | 0 |
| 12 | `/settings` | Settings | 200 | 0 |
| 13 | `/onboarding` | Setup (owner) | 200 | 0 |
| 14 | `/help` | Help & Support | 200 | 0 |
| 15 | `/library` | Resources (admin) | 200 | 0 |
| 16 | `/support` | (linked from Help) | 200 | 0 |
| 17 | `/training` | (linked from Help) | 200 | 0 |
| 18 | `/privacy` | (footer) | 200 | 0 |
| 19 | `/terms` | (footer) | 200 | 0 |

### 0.4 Baseline facts the design depends on

- Users are env-configured triples (`AUTH_OWNER_*`, `AUTH_ADMIN_*`, `AUTH_CLIENT_*`). Today `OWNER` is the agency operator (George), and `CLIENT` is the client business. There is no user table.
- Sessions: HMAC cookie `fna_session` (12h), plus a row in `auth_sessions` (Supabase REST, service-role key).
- Business data: nine `sync_*` tables keyed by GHL `location_id`, without RLS, written only by `/api/webhooks/ghl`. There are no create/edit APIs.
- Tenant configuration: `src/lib/tenant.ts`, with a hardcoded F&A default and a `globalThis` cache. Other process-global singletons: `src/lib/sync/factory.ts`, `src/lib/sync/memory-store.ts`, `src/lib/auth/session-store.ts`, `src/lib/auth/password.ts`.
- The 12 stage names in `src/lib/tenant.ts` (`FA_STAGE_ORDER`) already match the required stage list exactly.

---

## 1. Decisions (binding for this spec)

1. **Identity:** Supabase Auth, one identity per human (`auth.users`). No shared logins, and no env-configured users after cutover.
2. **Platform super-admin** is a global flag (`public.platform_admins`), separate from workspace roles. Platform admins are not implicitly members of any workspace.
3. **Workspace roles:** `owner`, `admin`, `employee`.
4. **UI preservation:** every existing sidebar item, route, layout, and style is preserved. New routes are limited to auth/system pages (`/invite/[token]`, `/no-access`, `/workspace-suspended`) and the platform console (`/platform/*`, outside the client sidebar).
5. **Active workspace:** existing URLs stay unchanged. The active workspace is stored server-side (`public.user_active_workspace`) and re-validated on every request in the database. Client-supplied workspace IDs are never trusted. The only place a client names a workspace is the switch request, which is validated for membership before it is stored.
6. **Database access:** ordinary operations use the user's JWT through PostgREST, so RLS applies. The service-role key is confined to an allowlist of administrative functions (§6.4).
7. **Tenant ownership:** every tenant-owned table has `workspace_id uuid not null`. The exceptions are global identity/platform tables (§3.2).
8. **Same-workspace relationships** are enforced with composite foreign keys `(workspace_id, <ref>_id)` plus triggers where a foreign key cannot express the rule (e.g. "assignee must be an active member").
9. **Provisioning** is one transactional, idempotent database function. It seeds configuration plus exactly 12 stages, and nothing else: no demo contacts, deals, appointments, messages, or members.
10. **Invitations** expire, are single-use, are bound to an email, and can only grant `owner`, `admin`, or `employee`. They can never grant platform-admin access.
11. **Super-admin workspace access** requires an explicit, time-boxed, reasoned grant. Every grant and every action under a grant is audited.
12. **Suspension:** a suspended workspace blocks all ordinary access, enforced in the database.
13. **No GHL** at runtime in the completed architecture.
14. **Workspaces only.** The tenant is `public.workspaces`; there is no organization layer above it. SQL proposing `organizations` tables or `organization_id` columns conflicts with this spec and is rejected (guarded by `tests/db/security-findings.test.ts` → "architecture guard").
15. **Theme and navigation are preserved** exactly (sidebar items, order, labels, routes, layout, colours, fonts). Multi-tenancy changes data and access, not the look.
16. **George** is a platform super-admin **and** the owner of the F&A workspace. The two are separate grants: platform admin via `public.platform_admins` (bootstrap script), F&A ownership via the F&A owner invitation accepted with his identity. Legacy env users (`AUTH_ADMIN_*`, `AUTH_CLIENT_*`) receive **no** automatic membership; anyone else joins only by individual invitation.
17. **Support phone:** `781-964-0654` (replaces `860-337-2617`; the `src/lib/brand.ts` change is deferred to the UI phase because P1 touches no application code).
18. **Actor attribution is database-controlled.** `created_by`, `updated_by`, `connected_by`, and note/message author columns are stamped from the authenticated identity by triggers and are not client-writable.
19. **Integrations and AI receptionist:** clients can never mark an integration verified or connected; only trusted server-side verification (service role) can. AI receptionist enablement is blocked by a database constraint until a trusted provider verification flow and a receptionist runtime exist.

---

## 2. Architecture overview

```
Browser ──cookie (sb-<ref>-auth-token)──▶ Next.js middleware (edge)
   │                                         └─ @supabase/ssr updateSession + getClaims()  → 401/redirect if no valid JWT
   ▼
Server Component / Route Handler (node)
   └─ getRequestContext()  (React cache, once per request)
        └─ rpc('request_context') with USER JWT
             └─ DB resolves: user, active workspace, role, permissions, workspace status, platform grant
   └─ data layer (src/lib/data/*) with USER JWT → PostgREST → RLS
             └─ every policy: workspace_id = private.active_workspace_id() AND private.has_permission('<perm>')
   └─ admin layer (src/lib/supabase/admin.ts, service role) — allowlisted functions only
```

Defense in depth: the app layer checks permissions for UX and error codes, and the database enforces the same rules. If the app layer has a bug, RLS still blocks cross-tenant access.

---

## 3. Database schema

### 3.1 Conventions

- Schemas: `public` holds tables exposed through PostgREST under RLS, and all RPCs. `private` holds helper and trigger functions and is not exposed. Super-admin RPCs live in `public` with a `platform_` prefix (e.g. `public.platform_provision_workspace`); each is `security definer` and calls `private.require_platform_admin()` (platform admin **and** AAL2). There is no `platform` schema.
- Extensions (in schema `extensions`): `citext` (emails), `btree_gist` (appointment overlap exclusion). `pgcrypto` is **not** required: UUIDs use core `gen_random_uuid()`, token hashing uses core `sha256()`, and invitation tokens are 64 hex characters from two v4 UUIDs.
- IDs: `uuid default gen_random_uuid()`. Timestamps: `timestamptz not null default now()`.
- Every tenant table has:
  - `workspace_id uuid not null references public.workspaces(id) on delete cascade`
  - `unique (workspace_id, id)`, the target for composite foreign keys
  - a `BEFORE UPDATE` trigger `private.forbid_workspace_change()` that rejects any change to `workspace_id`
  - an index leading with `workspace_id`
- Soft delete (`deleted_at`) on contacts, opportunities, appointments, and tasks. RLS select policies hide soft-deleted rows unless the caller holds `*.delete`.
- Default privileges: revoke all on all tables from `anon` and `authenticated`, then grant only what each policy needs. `anon` gets no table access. Public intake (future) goes through a narrow `security definer` RPC.

### 3.2 Global tables (no `workspace_id`; the allowed exceptions)

```sql
-- Supabase-managed: auth.users

create table public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);  -- Written only by scripts/bootstrap-platform-admin.ts (service role). No API, no invitation path.

create table public.workspaces (
  id                uuid primary key default gen_random_uuid(),
  slug              citext not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name              text not null check (length(name) between 1 and 120),
  status            text not null default 'active' check (status in ('active','suspended','archived')),
  provisioning_key  text not null unique,           -- idempotency key
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  suspended_at      timestamptz,
  suspended_reason  text
);  -- Tenant root: its id IS the workspace_id.

create table public.role_permissions (
  role       text not null check (role in ('owner','admin','employee')),
  permission text not null,
  primary key (role, permission)
);  -- Static reference data seeded by migration (§4). Not demo data.

create table public.platform_audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users(id),
  action      text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  reason      text,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);  -- Append-only (no update/delete grants; trigger rejects UPDATE/DELETE).
```

### 3.3 Membership and access tables (tenant-scoped)

```sql
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner','admin','employee')),
  status       text not null default 'active' check (status in ('active','removed')),
  invited_by   uuid references auth.users(id),
  joined_at    timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid references auth.users(id),
  primary key (workspace_id, user_id)
);
-- Rows are never hard-deleted while referenced; removal sets status='removed' so composite FKs stay valid.
-- Triggers: private.guard_last_owner() — a workspace with status 'active' must keep >= 1 active owner.

create table public.member_permission_overrides (
  workspace_id uuid not null,
  user_id      uuid not null,
  permission   text not null,
  allowed      boolean not null,
  primary key (workspace_id, user_id, permission),
  foreign key (workspace_id, user_id) references public.workspace_members(workspace_id, user_id) on delete cascade
);  -- Employees only (CHECK via trigger); cannot grant team.* or integrations.manage.

create table public.user_active_workspace (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  updated_at   timestamptz not null default now()
);  -- Written ONLY by rpc switch_workspace(); no direct insert/update grants.

create table public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        citext not null,
  role         text not null check (role in ('owner','admin','employee')),  -- no platform role exists here
  token_hash   bytea not null unique,                 -- sha256(token); raw token never stored
  expires_at   timestamptz not null check (expires_at <= created_at + interval '7 days'),
  created_by   uuid references auth.users(id),        -- null only for provisioning-created owner invite
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id),
  revoked_at   timestamptz,
  unique (workspace_id, id),
  check (not (accepted_at is not null and revoked_at is not null))
);
create unique index one_open_invite_per_email
  on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

create table public.platform_access_grants (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  admin_user_id uuid not null references public.platform_admins(user_id) on delete cascade,
  mode          text not null check (mode in ('read','write')),
  reason        text not null check (length(reason) >= 10),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null check (expires_at <= created_at + interval '8 hours'),
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users(id)
);
```

### 3.4 Workspace configuration

```sql
create table public.workspace_settings (
  workspace_id    uuid primary key references public.workspaces(id) on delete cascade,
  business_name   text not null,
  legal_name      text not null default '',
  timezone        text not null default 'America/New_York',
  industry        text not null default '',
  support_email   citext,
  business_phone  text,
  website_url     text,
  booking_url     text,
  review_url      text,
  brand_colors    jsonb not null default '{}',  -- same keys as today's ClientBranding
  logo_path       text,                           -- Supabase Storage path (bucket per §6.6)
  business_hours  jsonb not null default '{}',
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id)
);

create table public.ai_receptionist_configs (
  workspace_id        uuid primary key references public.workspaces(id) on delete cascade,
  enabled             boolean not null default false,
  greeting            text not null default '',
  business_hours_mode text not null default 'business_hours' check (business_hours_mode in ('always','business_hours','off')),
  escalation_user_id  uuid,
  faq                 jsonb not null default '[]',
  voice               text not null default 'default',
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id),
  foreign key (workspace_id, escalation_user_id)
    references public.workspace_members(workspace_id, user_id)
);  -- enabled cannot be true until a provider integration exists (CHECK via trigger). No runtime in this program.

create table public.integrations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider     text not null,                       -- e.g. 'google_calendar', 'twilio' (future)
  status       text not null default 'disconnected' check (status in ('disconnected','connected','error')),
  config       jsonb not null default '{}',         -- NON-secret settings only
  connected_by uuid references auth.users(id),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, provider),
  unique (workspace_id, id)
);

create table public.integration_secrets (
  integration_id uuid primary key,
  workspace_id   uuid not null,
  ciphertext     bytea not null,                    -- AES-GCM, key from server env (INTEGRATION_KEK), key_version tracked
  key_version    int not null,
  updated_at     timestamptz not null default now(),
  foreign key (workspace_id, integration_id) references public.integrations(workspace_id, id) on delete cascade
);  -- RLS enabled, NO policies, NO grants to authenticated/anon. Service-role only (§6.4).
```

### 3.5 CRM core

```sql
create table public.contacts (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  first_name       text not null default '',
  last_name        text not null default '',
  email            citext,
  phone            text,
  source           text not null default 'manual',
  owner_user_id    uuid,
  dnd              boolean not null default false,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (workspace_id, id),
  check (email is not null or phone is not null or (first_name || last_name) <> ''),
  foreign key (workspace_id, owner_user_id) references public.workspace_members(workspace_id, user_id)
);
create unique index contacts_email_per_ws on public.contacts (workspace_id, email) where email is not null and deleted_at is null;

create table public.contact_tags (
  workspace_id uuid not null,
  contact_id   uuid not null,
  tag          citext not null check (length(tag) between 1 and 60),
  primary key (workspace_id, contact_id, tag),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete cascade
);

create table public.contact_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  contact_id   uuid not null,
  body         text not null check (length(body) between 1 and 10000),
  author_id    uuid not null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, author_id)  references public.workspace_members(workspace_id, user_id)
);

create table public.pipelines (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  is_default   boolean not null default false,
  unique (workspace_id, id)
);
create unique index one_default_pipeline on public.pipelines (workspace_id) where is_default;

create table public.pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  pipeline_id  uuid not null,
  name         text not null check (length(name) between 1 and 60),
  position     smallint not null check (position between 1 and 12),
  kind         text not null check (kind in ('open','won','lost','nurture')),
  unique (pipeline_id, position) deferrable initially deferred,
  unique (workspace_id, pipeline_id, id),
  unique (workspace_id, id),
  foreign key (workspace_id, pipeline_id) references public.pipelines(workspace_id, id) on delete cascade
);
-- v1: stages may be renamed (pipeline.configure) but not added/deleted; a constraint trigger keeps exactly 12 per pipeline.

create table public.opportunities (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  contact_id       uuid not null,
  pipeline_id      uuid not null,
  stage_id         uuid not null,
  title            text not null check (length(title) between 1 and 200),
  value_cents      bigint not null default 0 check (value_cents >= 0),
  currency         char(3) not null default 'USD',
  status           text not null default 'open' check (status in ('open','won','lost')),
  assigned_user_id uuid,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz,
  deleted_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id),
  foreign key (workspace_id, pipeline_id, stage_id) references public.pipeline_stages(workspace_id, pipeline_id, id),
  foreign key (workspace_id, assigned_user_id) references public.workspace_members(workspace_id, user_id)
);
-- Trigger: status follows stage.kind (won/lost) on stage move; closed_at set accordingly.
```

### 3.6 Scheduling

```sql
create table public.calendars (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  name             text not null,
  slug             citext not null,
  timezone         text not null,
  duration_minutes smallint not null check (duration_minutes between 5 and 480),
  is_primary       boolean not null default false,
  active           boolean not null default true,
  unique (workspace_id, slug),
  unique (workspace_id, id)
);

create table public.calendar_members (
  workspace_id uuid not null,
  calendar_id  uuid not null,
  user_id      uuid not null,
  primary key (workspace_id, calendar_id, user_id),
  foreign key (workspace_id, calendar_id) references public.calendars(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id)     references public.workspace_members(workspace_id, user_id)
);

create table public.availability_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  calendar_id  uuid not null,
  weekday      smallint not null check (weekday between 0 and 6),
  start_time   time not null,
  end_time     time not null check (end_time > start_time),
  foreign key (workspace_id, calendar_id) references public.calendars(workspace_id, id) on delete cascade
);

create table public.appointments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  calendar_id      uuid not null,
  contact_id       uuid not null,
  opportunity_id   uuid,
  assigned_user_id uuid,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null check (ends_at > starts_at),
  status           text not null default 'booked' check (status in ('booked','confirmed','completed','cancelled','no_show')),
  notes            text not null default '',
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, calendar_id)      references public.calendars(workspace_id, id),
  foreign key (workspace_id, contact_id)       references public.contacts(workspace_id, id),
  foreign key (workspace_id, opportunity_id)   references public.opportunities(workspace_id, id),
  foreign key (workspace_id, assigned_user_id) references public.workspace_members(workspace_id, user_id),
  exclude using gist (calendar_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status in ('booked','confirmed') and deleted_at is null)
);
```

### 3.7 Engagement, tasks, reviews, audit

```sql
create table public.conversations (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  contact_id       uuid not null,
  channel          text not null check (channel in ('sms','email','call','webchat','internal')),
  status           text not null default 'open' check (status in ('open','closed')),
  assigned_user_id uuid,
  last_message_at  timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)       references public.contacts(workspace_id, id),
  foreign key (workspace_id, assigned_user_id) references public.workspace_members(workspace_id, user_id)
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  conversation_id uuid not null,
  direction       text not null check (direction in ('inbound','outbound','internal')),
  body            text not null check (length(body) between 1 and 20000),
  author_user_id  uuid,
  delivery_status text not null default 'not_sent' check (delivery_status in ('not_sent','queued','sent','delivered','failed')),
  created_at      timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, author_user_id)  references public.workspace_members(workspace_id, user_id)
);  -- This program writes only direction='internal'; no row may leave 'not_sent' (no outbound provider).

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  title            text not null check (length(title) between 1 and 200),
  description      text not null default '',
  due_at           timestamptz,
  status           text not null default 'open' check (status in ('open','done','cancelled')),
  contact_id       uuid,
  opportunity_id   uuid,
  assigned_user_id uuid,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)       references public.contacts(workspace_id, id),
  foreign key (workspace_id, opportunity_id)   references public.opportunities(workspace_id, id),
  foreign key (workspace_id, assigned_user_id) references public.workspace_members(workspace_id, user_id)
);

create table public.reviews (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id   uuid,
  source       text not null default 'manual',
  rating       smallint check (rating between 1 and 5),
  body         text not null default '',
  received_at  timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id)
);

create table public.activity_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type  text not null,
  entity_id    uuid,
  action       text not null,
  actor_id     uuid references auth.users(id),
  actor_kind   text not null check (actor_kind in ('member','platform_admin','system')),
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);  -- Append-only; feeds Dashboard "Recent Activity" and Reports.

create table public.workspace_audit_log (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id     uuid references auth.users(id),
  actor_kind   text not null check (actor_kind in ('member','platform_admin','system')),
  grant_id     uuid references public.platform_access_grants(id),
  action       text not null,         -- e.g. member.role_changed, invitation.created, settings.updated
  target       text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);  -- Append-only.
```

### 3.8 Same-workspace relationship rules (summary)

| Relationship | Enforcement |
| --- | --- |
| Opportunity → contact | FK `(workspace_id, contact_id)` → `contacts(workspace_id, id)` |
| Opportunity → stage (and stage belongs to opportunity's pipeline) | FK `(workspace_id, pipeline_id, stage_id)` → `pipeline_stages(workspace_id, pipeline_id, id)` |
| Appointment → calendar / contact / opportunity | Composite FKs on `(workspace_id, …)` |
| Task → contact / opportunity | Composite FKs |
| Conversation → contact; message → conversation | Composite FKs |
| Any `*_user_id` / `assigned_user_id` / `owner_user_id` / `escalation_user_id` / calendar member | FK `(workspace_id, user_id)` → `workspace_members` **plus** trigger `private.assert_active_member()` on insert/update when the value changes (removed members cannot be newly assigned) |
| `workspace_id` immutability | `private.forbid_workspace_change()` trigger on every tenant table |

Removing a member (`rpc remove_member`) runs in one transaction. It sets `status='removed'`, unassigns that user from open opportunities, open tasks, open conversations, and calendar memberships, clears `escalation_user_id` if it points to them, deletes their `user_active_workspace` row if it points to this workspace, and writes an audit row.

### 3.9 Retired tables

`sync_contacts`, `sync_contact_tags`, `sync_opportunities`, `sync_appointments`, `sync_conversation_events`, `sync_tasks`, `sync_review_events`, `sync_events`, `sync_idempotency`, `auth_sessions`. These are dropped only in the final cleanup migration (§9, M14), after cutover plus a retention window and a verified backup.

---

## 4. Roles and permissions

### 4.1 Permission matrix

Legend: ✔ allowed · — denied · (o) owner-only nuance noted.

| Permission | Owner | Admin | Employee | Platform admin (no grant) | Platform admin + `read` grant | Platform admin + `write` grant |
| --- | --- | --- | --- | --- | --- | --- |
| `dashboard.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `contacts.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `contacts.write` | ✔ | ✔ | ✔ | — | — | ✔ |
| `contacts.delete` | ✔ | ✔ | — | — | — | ✔ |
| `pipeline.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `opportunities.write` | ✔ | ✔ | ✔ | — | — | ✔ |
| `opportunities.delete` | ✔ | ✔ | — | — | — | ✔ |
| `pipeline.configure` (rename stages) | ✔ | ✔ | — | — | — | ✔ |
| `calendar.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `appointments.write` | ✔ | ✔ | ✔ | — | — | ✔ |
| `calendar.configure` | ✔ | ✔ | — | — | — | ✔ |
| `conversations.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `conversations.write` (internal notes only) | ✔ | ✔ | ✔ | — | — | ✔ |
| `tasks.read` / `tasks.write` | ✔ | ✔ | ✔ | — | read only | ✔ |
| `reviews.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `reports.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `automations.read` / `marketing.read` / `payments.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `settings.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `settings.write` (business profile, branding, hours) | ✔ | ✔ | — | — | — | ✔ |
| `ai_receptionist.read` | ✔ | ✔ | — | — | ✔ | ✔ |
| `ai_receptionist.write` | ✔ | ✔ | — | — | — | ✔ |
| `integrations.read` | ✔ | ✔ | — | — | ✔ | ✔ |
| `integrations.manage` (credentials) | ✔ | — | — | — | — | — |
| `team.read` | ✔ | ✔ | ✔ | — | ✔ | ✔ |
| `team.invite_employee` | ✔ | ✔ | — | — | — | ✔ |
| `team.invite_admin` | ✔ | — | — | — | — | — |
| `team.invite_owner` | ✔ | — | — | — | — | — |
| `team.change_role` | ✔ (o) | employee↔employee overrides only | — | — | — | — |
| `team.remove` | ✔ (o) | employees only | — | — | — | — |
| `audit.read` | ✔ | ✔ | — | — | ✔ | ✔ |
| `onboarding.read` (Setup page) | ✔ | — | — | — | ✔ | ✔ |
| `library.read` (Resources page) | ✔ | ✔ | — | — | ✔ | ✔ |
| Platform console (`/platform/*`) | — | — | — | ✔ | ✔ | ✔ |

Platform-only actions, available to platform admins regardless of grant: provision a workspace, suspend/reactivate a workspace, create/revoke access grants, read the platform audit log.

Write grants are capped below the owner: they cannot change roles, manage integration credentials, or invite owners or admins. A write grant on a suspended workspace is rejected, and a read grant is allowed so support can investigate.

### 4.2 Role-change rules (enforced in `rpc set_member_role` / `rpc remove_member`)

1. Nobody can change or remove their own membership through these RPCs. Leaving a workspace is a separate `rpc leave_workspace`, which is blocked for the last owner.
2. Only owners can grant or revoke `owner` or `admin`.
3. Admins can only remove employees and edit employee permission overrides.
4. Employees cannot change any membership.
5. A workspace must always keep at least one active owner (`private.guard_last_owner()` trigger, which also covers direct-SQL paths).
6. Platform admins cannot change roles, even with a write grant. Ownership disputes go through a documented manual procedure, not the API.
7. `workspace_members.role`, `status`, and `user_id` have no update grant for `authenticated`. Changes happen only through the RPCs.

### 4.3 Sidebar visibility mapping (current → new)

| Sidebar item | Current gate | New gate |
| --- | --- | --- |
| Setup (`/onboarding`) | `minRole: "OWNER"` | `onboarding.read` |
| Resources (`/library`) | `minRole: "ADMIN"` | `library.read` |
| All others | any signed-in role | the page's `*.read` permission (all roles hold it) |

Order, labels, icons, and hrefs in `src/components/Sidebar.tsx` stay unchanged. Only the predicate changes.

---

## 5. Authentication transition and owner bootstrap

### 5.1 Target auth flow

- Packages: `@supabase/ssr` and `@supabase/supabase-js`.
- `src/middleware.ts` (Next 15 middleware, edge) does three things:
  1. Creates a per-request `createServerClient` with `getAll`/`setAll` cookie adapters, and applies the cache headers passed to `setAll` to the response.
  2. Calls `supabase.auth.getClaims()` immediately, with no code in between. This verifies the JWT signature and expiry.
  3. Preserves today's public paths (except GHL paths, removed in Phase 7) and today's 307 to `/login?next=…` for pages and 401 JSON for APIs.
- Server: `getRequestContext()` calls `rpc('request_context')` with the user JWT. It returns `{ userId, email, name, workspace: {id, name, slug, status} | null, role | null, permissions[], isPlatformAdmin, grant: {id, mode, expiresAt} | null }`. A missing workspace sends the user to `/no-access` (or `/platform` for platform admins); a suspended one sends them to `/workspace-suspended`.
- Sensitive mutations (role changes, removals, invitation creation, grants, provisioning, suspension) additionally call `supabase.auth.getUser()`, so a revoked session is caught before its JWT expires.
- Membership removal and suspension take effect on the **next query**, without waiting for JWT expiry, because RLS evaluates `private.active_workspace_id()` on every statement.
- Logout (and any other end of an Auth session: refresh-token revocation, password change, admin sign-out) also takes effect on the next request (M21). Every access token names its session (`session_id`); `private.active_workspace_id()`, `private.is_platform_admin()`, and `request_context` require that `auth.sessions` row to still exist, and a PostgREST pre-request check (`public.check_request_session`) answers 401 to any Data API request carrying a dead session. The app treats the result as signed out: APIs answer 401 `unauthenticated` and pages redirect to `/login`, both expiring the stale `sb-*-auth-token` cookies. Other sessions of the same user continue; a refreshed token keeps its session and stays valid; all tabs of one browser share the cookie, so they end together.
- Platform admins must sign in with MFA (AAL2). `private.is_platform_admin()` returns true only when `auth.jwt()->>'aal' = 'aal2'` (and the session is live). There is no override: the `app.platform_allow_aal1` setting was removed in M26 (`20261101002500_integrity_round3.sql`), and a test checks that setting it has no effect.
- Login UI: `/login` keeps its layout. `POST /api/auth/login` keeps its request shape `{email, password}` and response shape `{ok, user}`, but calls `signInWithPassword` on the SSR client. Supabase Auth's built-in rate limits replace the in-memory limiter in `src/lib/auth/password.ts`.

### 5.2 Transition steps

| Step | Change | Flag state | Rollback |
| --- | --- | --- | --- |
| T1 | Add Supabase Auth code paths alongside legacy auth. `AUTH_PROVIDER=legacy` default. | legacy | none needed |
| T2 | Local/staging: create George's auth user, run `scripts/bootstrap-platform-admin.ts --email … --env local`, enrol MFA. | legacy (prod) / supabase (local) | delete the local row |
| T3 | Staging: provision the F&A workspace (`provisioning_key = 'fa-live'`), get the owner invitation URL (shown once, no email sent), and accept it with the intended owner identity. | supabase (staging) | run the rollback script on staging (no archive RPC exists yet) |
| T4 | Staging parity: run the acceptance suite (§10) and screenshot diff against `docs/baseline/`. | supabase (staging) | — |
| T5 | **Production cutover (requires George's explicit approval, and a paid Supabase plan — D5):** apply the required migration manifest (`docs/STAGING_CUTOVER_CHECKLIST.md` §5: M1–M14 and M16–M26, never M15), bootstrap the platform admin, provision F&A, set `AUTH_PROVIDER=supabase`. | supabase | set `AUTH_PROVIDER=legacy` and redeploy the previous build. The legacy env credentials stay in place until T6. |
| T6 | After 14 stable days: remove the legacy auth code, the `AUTH_OWNER_*`/`AUTH_ADMIN_*`/`AUTH_CLIENT_*` env vars, and the `fna_session` cookie handling. Apply M15 (drop `auth_sessions`, `sync_*`) after a backup. | supabase | restore from backup (documented in the runbook) |

Role mapping at cutover (D6): today's `OWNER` (George) becomes a platform admin **and**, by accepting the F&A owner invitation with the same identity, the F&A workspace owner. Legacy `ADMIN` and `CLIENT` users receive **no** automatic membership; if George wants them in F&A, each gets an individual invitation with the role he chooses. No shared credentials carry over.

If the bootstrap owner invitation is lost or expires before anyone accepts it, a platform admin calls `public.platform_rotate_bootstrap_invitation(workspace_id, reason)`. In one transaction it revokes every open owner invitation and issues a new one to the provisioned `bootstrap_owner_email`, writing both platform and workspace audit rows. It is refused permanently once the workspace has ever had an owner (`workspaces.owner_acquired_at`); after that, owners invite owners.

### 5.3 Owner bootstrap for a new workspace

1. A platform admin calls `POST /api/platform/workspaces` with `{ provisioningKey, name, slug, ownerEmail }`.
2. `public.platform_provision_workspace(...)` runs in **one transaction**:
   - Idempotency: `insert … on conflict (provisioning_key) do nothing`. If a row exists with the same `(name, slug, ownerEmail)`, it returns the existing workspace and the open owner invitation, if any. If the existing row differs, it raises `conflict`.
   - Inserts `workspaces`, `workspace_settings` (business_name = name; everything else default or empty), `ai_receptionist_configs` (disabled), one default pipeline, and **exactly 12** stages with these positions and kinds:

     | Pos | Stage | Kind |
     | --- | --- | --- |
     | 1 | New Lead | open |
     | 2 | Attempting Contact | open |
     | 3 | Connected | open |
     | 4 | Qualified | open |
     | 5 | Appointment Booked | open |
     | 6 | Appointment Completed | open |
     | 7 | Estimate / Proposal Sent | open |
     | 8 | Follow-Up | open |
     | 9 | Decision Pending | open |
     | 10 | Won | won |
     | 11 | Lost | lost |
     | 12 | Long-Term Nurture | nurture |

   - Creates one `owner` invitation for `ownerEmail` (expires in 72h). The raw token is generated server-side and returned once. Only its hash is stored.
   - Writes `platform_audit_log` (`workspace.provisioned`).
   - Inserts **no** contacts, opportunities, appointments, calendars, conversations, messages, tasks, reviews, members, or integrations.
3. The API returns `{ workspaceId, inviteUrl }`. No email is sent in this program; the platform admin delivers the link manually.
4. The invitee opens `/invite/[token]`. If they have no account, the server verifies the token (`rpc peek_invitation`, which returns workspace name, role, and masked email). They then set a password, and the server calls `auth.admin.createUser({ email, password, email_confirm: true })`. This is service-role allowlist item A1; holding the single-use token sent to that email is the proof of email control. Existing users sign in first.
5. `rpc accept_invitation(token)` runs with the user JWT, in one transaction:
   - It requires `auth.email() = invitation.email`, `accepted_at is null`, `revoked_at is null`, and `expires_at > now()`, and the workspace must be `active`.
   - It upserts `workspace_members` (re-activating a `removed` row, if any) and sets `accepted_at`/`accepted_by` through a conditional update. Zero rows updated means the invitation was already used, and the call fails.
   - It sets `user_active_workspace` and writes an audit row.

Calendars are not seeded (D2, resolved: seed configuration and exactly 12 stages only — no calendars and no business records). The Calendars page shows a native empty state with a "Create calendar" action for users who hold `calendar.configure`.

---

## 6. Authorization internals

### 6.1 Core SQL helpers (`private` schema, `security definer`, `set search_path = ''`, `stable`)

```sql
-- Returns the caller's validated active workspace, or NULL.
create function private.active_workspace_id() returns uuid ... as $$
  select uaw.workspace_id
  from public.user_active_workspace uaw
  join public.workspaces w on w.id = uaw.workspace_id
  where uaw.user_id = auth.uid()
    and (
      (w.status = 'active' and exists (
         select 1 from public.workspace_members m
         where m.workspace_id = uaw.workspace_id and m.user_id = auth.uid() and m.status = 'active'))
      or exists (
         select 1 from public.platform_access_grants g
         where g.workspace_id = uaw.workspace_id and g.admin_user_id = auth.uid()
           and g.revoked_at is null and g.expires_at > now()
           and private.is_platform_admin()
           and (w.status = 'active' or g.mode = 'read'))
    );
$$;

create function private.has_permission(p text) returns boolean ...;
-- member: role_permissions ∪ overrides(allowed) − overrides(denied), for the active workspace
-- platform grant: read → only '*.read' permissions in the grant column of §4.1; write → write-grant column

create function private.is_platform_admin() returns boolean ...;  -- platform_admins row + AAL2 rule (§5.1)
create function private.current_actor_kind() returns text ...;    -- 'member' | 'platform_admin'
```

Policies wrap helpers in `(select …)` so Postgres evaluates them once per statement.

### 6.2 RLS policy template (applied to every tenant table)

```sql
alter table public.contacts enable row level security;
alter table public.contacts force row level security;

create policy contacts_select on public.contacts for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('contacts.read'))
         and (deleted_at is null or (select private.has_permission('contacts.delete'))));

create policy contacts_insert on public.contacts for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('contacts.write')));

create policy contacts_update on public.contacts for update to authenticated
  using      (workspace_id = (select private.active_workspace_id()) and (select private.has_permission('contacts.write')))
  with check (workspace_id = (select private.active_workspace_id()) and (select private.has_permission('contacts.write')));

-- No DELETE policy: deletion is soft (update deleted_at), gated in rpc soft_delete_contact by contacts.delete.
```

- Per-table permission keys follow §4.1.
- Append-only tables (`activity_events`, `workspace_audit_log`) get SELECT policies only. Writes come from triggers and RPCs.
- `workspace_members`: SELECT is allowed for same active workspace + `team.read`. There is no INSERT/UPDATE/DELETE policy, so changes only go through RPCs.
- `workspace_invitations`: SELECT requires `team.read` and excludes `token_hash` (column grant). Writes only through RPCs.
- `user_active_workspace`: SELECT returns only the caller's own row. Writes only through `rpc switch_workspace`.
- `platform_access_grants`, `platform_audit_log`, `platform_admins`: SELECT only through `public.platform_*` RPCs.
- `workspaces`: SELECT is limited to workspaces where the caller has an active membership or an active grant, and returns only id, name, slug, and status.
- `integration_secrets`: RLS is forced and no policies exist, so no `authenticated` access.

### 6.3 Request context in the app

- `src/lib/authz/context.ts` exports `getRequestContext()`, wrapped in React `cache()`, and `requireContext({ permission? })`.
  - Page variant: redirects to `/login`, `/no-access`, or `/workspace-suspended`.
  - API variant: returns a typed error response (§7.1).
- The data layer never accepts a `workspaceId` argument from callers. It reads `ctx.workspace.id` from the context, and RLS re-checks it anyway.
- Any `workspaceId` / `workspace_id` key in a request body, query string, header, or cookie is ignored. Mutation routes strip these keys before passing payloads on. A unit test asserts that no route handler reads such a key.

### 6.4 Service-role allowlist (`src/lib/supabase/admin.ts`, `server-only`)

| ID | Function | Why service role is required | Guard |
| --- | --- | --- | --- |
| A1 | `createUserFromInvitation(token, password)` | Supabase admin user creation | Calls `rpc peek_invitation` first; the email comes from the invitation, never from the client |
| A2 | `scripts/bootstrap-platform-admin.ts` | Writes `platform_admins` | CLI only; refuses non-local targets unless `--env staging\|production` and a typed confirmation are given |
| A3 | `readIntegrationSecret(workspaceId, provider)` / `writeIntegrationSecret(...)` | `integration_secrets` has no user grants | Callers must first pass `requireContext({ permission: 'integrations.manage' })`; the workspaceId comes from the context |
| A4 | Test harness (`tests/integration/_harness.ts`) | Creates test users locally | Refuses unless the URL host is `127.0.0.1`/`localhost` or the project ref is in `TEST_SUPABASE_PROJECT_REFS` |
| A5 (P2) | `platformWriteWorkspaceLogo` / `platformDeleteWorkspaceLogo` / `claimPlatformStorageChange` / `completePlatformStorageChange` — only caller `src/app/api/platform/workspace-logo/route.ts` | Storage writes require membership (R2-3 decision A); a platform write grant cannot write through RLS; audit outcomes must not be client-controlled | Route requires AUTH_PROVIDER=supabase, an AAL2 platform admin with no membership and a live `write` grant, a fresh `getUser()`; the workspace and actor come from the request context; the path is fixed to `<ws>/logo.(png\|jpg\|webp)`; `platform_storage_change_requested` (user JWT) records the request; claim and outcome RPCs are executable by `service_role` only; the outcome is whether the database saw this operation's own token-tagged write commit, and none is recorded while the operation may still be running (§16.2, §16.6) |

As implemented in P2 the static check is `tests/p2-auth.test.ts` (SR-1): only `src/lib/supabase/admin.ts` may read `SUPABASE_SERVICE_ROLE_KEY` among new code, only the workspace-logo route imports it, and the pre-existing legacy readers (`src/lib/sync/db-client.ts`, `src/lib/sync/supabase-rest-auth.ts`, `src/lib/auth/session-store.ts`, `src/lib/auth/session-edge.ts`, `src/lib/deployment/validate.ts`, `scripts/generate-client-deployment.ts`) are tolerated until P7 retires them. After P7 (§21) the tolerated set is four files, all legacy-mode only and retired at T6: `src/lib/legacy/rest-client.ts` (read-only snapshot reader), `src/lib/legacy/rest-auth.ts`, `src/lib/auth/session-store.ts`, `src/lib/auth/session-edge.ts`.

A static test (`tests/unit/service-role-allowlist.test.ts`) fails if any file outside `src/lib/supabase/admin.ts`, `scripts/bootstrap-platform-admin.ts`, and `tests/integration/_harness.ts` imports the admin client or reads `SUPABASE_SERVICE_ROLE_KEY`.

Platform operations (provision, suspend, grants) do **not** use the service role. They run as `security definer` RPCs under the platform admin's own JWT.

### 6.5 Caches and globals

- Remove the `globalThis` caches in `src/lib/tenant.ts`, `src/lib/sync/factory.ts`, `src/lib/sync/memory-store.ts`, `src/lib/auth/session-store.ts`, and `src/lib/auth/password.ts`.
- Supabase clients are created per request, never module-global.
- Only request-scoped caching is allowed: React `cache()`. Any future cross-request cache key must include `workspace_id`; a static test greps for `globalThis` in `src/`.

### 6.6 Storage

- Storage holds only workspace logos in this program.
- Bucket `workspace-assets` (private); object path `"{workspace_id}/logo.{ext}"`.
- Storage policies: `(storage.foldername(name))[1]::uuid = private.active_workspace_id()`. Reads need `settings.read` and writes need `settings.write`.
- Logos are served through short-lived signed URLs.

---

## 7. API contracts

### 7.1 Conventions

- All APIs are `force-dynamic` JSON. Success: `{ ok: true, ... }`. Error: `{ ok: false, error: "<human message>", code: "<code>" }`. The `error` string stays for compatibility with existing UI.

  | HTTP | `code` |
  | --- | --- |
  | 401 | `unauthenticated` |
  | 403 | `forbidden` |
  | 403 | `no_active_workspace` |
  | 423 | `workspace_suspended` |
  | 404 | `not_found` (also for IDs belonging to another workspace — never reveal existence) |
  | 409 | `conflict` |
  | 410 | `invitation_expired` / `invitation_used` / `invitation_revoked` |
  | 422 | `validation_failed` (with `fields`) |
  | 429 | `rate_limited` |
- Input validated with `zod`. IDs are UUIDs; anything else returns 422.
- Pagination: `?limit` (≤ 100, default 50) and `?cursor` (opaque). Responses carry `nextCursor`.
- Mutations return the updated resource and write `activity_events` and, where relevant, `workspace_audit_log`.

### 7.2 Auth and session

| Method & path | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /api/auth/login` | public | `{ email, password }` | `{ ok, user: { id, email, name } }` + Supabase cookies |
| `POST /api/auth/logout` | session | — | `{ ok }`, clears cookies (`signOut({ scope: 'local' })`) |
| `GET /api/auth/me` | public (null when signed out) | — | `{ ok, authEnforced: true, user: {id,email,name} \| null, role: 'owner'\|'admin'\|'employee'\|null, legacyRole: 'OWNER'\|'ADMIN'\|'CLIENT'\|null, permissions: string[], workspace: {id,name,slug,status} \| null, isPlatformAdmin, grant: {mode, expiresAt} \| null }` |
| `GET /api/workspaces` | session | — | `{ ok, workspaces: [{ id, name, slug, status, role }] }` (active memberships plus active grants) |
| `POST /api/workspaces/active` | session | `{ workspaceId }` | `{ ok, workspace }`; calls `rpc switch_workspace` (403 if not member/grant; 423 if suspended) |

`legacyRole` maps owner→OWNER, admin→ADMIN, employee→CLIENT, so existing UI predicates keep working until each page migrates.

### 7.3 Existing read endpoints (shape-compatible, re-backed by native tables)

| Path | Permission | Notes |
| --- | --- | --- |
| `GET /api/dashboard/summary` | `dashboard.read` | Same `DashboardSummary` shape as `src/lib/sync/types.ts` today |
| `GET /api/dashboard/contacts` | `contacts.read` | Same item shape (`ContactRecord`-compatible adapter) |
| `GET /api/dashboard/opportunities` | `pipeline.read` | Same shape; stage names from `pipeline_stages` |
| `GET /api/dashboard/appointments` | `calendar.read` | Same shape |
| `GET /api/dashboard/conversations` | `conversations.read` | Same shape (used by `/inbox`) |
| `GET /api/dashboard/events` | `dashboard.read` | From `activity_events` |
| `GET /api/tenant/config` | session + `settings.read` | Same `client` block from `workspace_settings`; `owner` block becomes `{ pipelineName, stagesCount }` for `settings.write` holders |
| `GET /api/tenant/public` | public | Platform brand only (F&A platform identity). Client branding moves to authenticated `/api/tenant/config`, because a public endpoint cannot know the workspace without trusting client input |
| `GET /api/health` | public | `{ ok, db: 'ok'\|'error', authProvider }` (no GHL fields) |

### 7.4 New native endpoints

| Method & path | Permission | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/contacts` | contacts.read | `q, tag, ownerUserId, limit, cursor` | `{ ok, items, nextCursor }` |
| `POST /api/contacts` | contacts.write | `{ firstName, lastName, email?, phone?, source?, ownerUserId?, tags?[] }` | `{ ok, contact }` |
| `GET /api/contacts/[id]` | contacts.read | — | `{ ok, contact, tags, notes, opportunities, appointments }` |
| `PATCH /api/contacts/[id]` | contacts.write | partial of POST | `{ ok, contact }` |
| `DELETE /api/contacts/[id]` | contacts.delete | — | `{ ok }` (soft delete) |
| `POST /api/contacts/[id]/notes` | contacts.write | `{ body }` | `{ ok, note }` |
| `GET /api/pipeline` | pipeline.read | — | `{ ok, pipeline: { id, name, stages: [{ id, name, position, kind }] } }` |
| `PATCH /api/pipeline/stages/[id]` | pipeline.configure | `{ name }` | `{ ok, stage }` |
| `GET /api/opportunities` | pipeline.read | `stageId, assignedUserId, status, limit, cursor` | `{ ok, items, nextCursor }` |
| `POST /api/opportunities` | opportunities.write | `{ contactId, stageId, title, valueCents?, assignedUserId? }` | `{ ok, opportunity }` |
| `PATCH /api/opportunities/[id]` | opportunities.write | `{ title?, valueCents?, assignedUserId? }` | `{ ok, opportunity }` |
| `POST /api/opportunities/[id]/move` | opportunities.write | `{ stageId }` | `{ ok, opportunity }` |
| `DELETE /api/opportunities/[id]` | opportunities.delete | — | `{ ok }` |
| `GET /api/calendars` | calendar.read | — | `{ ok, items }` |
| `POST /api/calendars` | calendar.configure | `{ name, slug, timezone, durationMinutes, memberUserIds?[] }` | `{ ok, calendar }` |
| `PATCH /api/calendars/[id]` | calendar.configure | partial | `{ ok, calendar }` |
| `PUT /api/calendars/[id]/availability` | calendar.configure | `{ rules: [{ weekday, start, end }] }` | `{ ok, rules }` |
| `GET /api/appointments` | calendar.read | `from, to, calendarId` | `{ ok, items }` |
| `POST /api/appointments` | appointments.write | `{ calendarId, contactId, startsAt, endsAt, opportunityId?, assignedUserId?, notes? }` | `{ ok, appointment }` (409 on overlap) |
| `PATCH /api/appointments/[id]` | appointments.write | `{ startsAt?, endsAt?, status?, notes?, assignedUserId? }` | `{ ok, appointment }` |
| `GET /api/conversations` | conversations.read | `status, assignedUserId, limit, cursor` | `{ ok, items, nextCursor }` |
| `GET /api/conversations/[id]/messages` | conversations.read | `limit, cursor` | `{ ok, items, nextCursor }` |
| `POST /api/conversations/[id]/notes` | conversations.write | `{ body }` | `{ ok, message }` (direction `internal`, never sent) |
| `GET /api/tasks` · `POST /api/tasks` · `PATCH /api/tasks/[id]` | tasks.read / tasks.write | `{ title, description?, dueAt?, contactId?, opportunityId?, assignedUserId?, status? }` | `{ ok, task(s) }` |
| `GET /api/reviews` | reviews.read | `limit, cursor` | `{ ok, items, nextCursor }` |
| `GET /api/reports/summary` | reports.read | `from, to` | `{ ok, leadsByStage, wonValueCents, appointmentsByStatus, ... }` |
| `GET /api/team` | team.read | — | `{ ok, members: [{ userId, name, email, role, status, joinedAt }] }` |
| `PATCH /api/team/[userId]` | per §4.2 | `{ role }` or `{ overrides: { [perm]: boolean } }` | `{ ok, member }` |
| `DELETE /api/team/[userId]` | per §4.2 | — | `{ ok }` |
| `GET /api/team/invitations` | team.read | — | `{ ok, items: [{ id, email, role, expiresAt, status }] }` |
| `POST /api/team/invitations` | team.invite_* by role | `{ email, role }` | `{ ok, invitation, inviteUrl }` (URL returned once; **no email sent**) |
| `DELETE /api/team/invitations/[id]` | team.invite_* by role | — | `{ ok }` (revoke) |
| `GET /api/invitations/[token]` | public | — | `{ ok, workspaceName, role, emailMasked, accountExists }` or 410 |
| `POST /api/invitations/[token]/accept` | public (new account) or session | `{ password? }` | `{ ok, workspace }` |
| `GET /api/settings/workspace` · `PATCH` | settings.read / settings.write | `workspace_settings` fields | `{ ok, settings }` |
| `GET /api/settings/ai-receptionist` · `PUT` | ai_receptionist.read / .write | config fields (no provider secrets) | `{ ok, config }` |
| `GET /api/integrations` | integrations.read | — | `{ ok, items: [{ provider, status, config }] }` (never secrets) |
| `GET /api/audit` | audit.read | `limit, cursor` | `{ ok, items }` |
| `GET /api/onboarding/checklist` | onboarding.read | — | `{ ok, items: [{ key, done }] }` (native: profile, team, calendar, AI config) |

### 7.5 Platform endpoints (`isPlatformAdmin` + AAL2)

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/platform/workspaces` | `q, status` | `{ ok, items: [{ id, name, slug, status, memberCount, createdAt }] }` |
| `POST /api/platform/workspaces` | `{ provisioningKey, name, slug, ownerEmail }` | `{ ok, workspaceId, inviteUrl \| null, created: boolean }` |
| `POST /api/platform/workspaces/[id]/suspend` | `{ reason }` | `{ ok, workspace }` |
| `POST /api/platform/workspaces/[id]/reactivate` | `{ reason }` | `{ ok, workspace }` |
| `POST /api/platform/workspaces/[id]/access` | `{ mode: 'read'\|'write', reason, durationMinutes ≤ 480 }` | `{ ok, grant }`; also switches the admin's active workspace |
| `DELETE /api/platform/access/[grantId]` | — | `{ ok }` |
| `GET /api/platform/audit` | `workspaceId?, limit, cursor` | `{ ok, items }` |

### 7.6 Removed endpoints

These are removed in Phase 7: `/api/ghl/health`, `/api/webhooks/ghl`, `/api/leads` (dry-run GHL mapper), `/api/sync/health`, `/api/events`, `/api/onboarding/readiness`. Native public lead intake (`POST /api/intake/[publicKey]`, a `security definer` RPC with a per-workspace hashed key and rate limiting) is **in scope for a later phase** (D3, resolved). It is not part of P1–P2.

---

## 8. Implementation files

### 8.1 New

```
supabase/config.toml                                   # local CLI config (auth: email confirm on, signups disabled — invites only)
supabase/migrations/20261101000100_extensions_schemas.sql
supabase/migrations/20261101000200_identity_platform.sql
supabase/migrations/20261101000300_membership_access.sql
supabase/migrations/20261101000400_authz_helpers.sql
supabase/migrations/20261101000500_workspace_config.sql
supabase/migrations/20261101000600_crm_core.sql
supabase/migrations/20261101000700_scheduling.sql
supabase/migrations/20261101000800_engagement_audit.sql
supabase/migrations/20261101000900_triggers_integrity.sql
supabase/migrations/20261101001000_rls_policies_grants.sql
supabase/migrations/20261101001100_rpc_membership_invites.sql
supabase/migrations/20261101001200_rpc_platform_provisioning.sql
supabase/migrations/20261101001300_storage_reporting_views.sql
supabase/rollback/<same names>.down.sql                # local/staging only
src/lib/supabase/server.ts         # createServerClient for RSC/route handlers (per request)
src/lib/supabase/middleware.ts     # updateSession() used by src/middleware.ts
src/lib/supabase/admin.ts          # service-role client + allowlisted functions A1, A3 (server-only)
src/lib/authz/context.ts           # getRequestContext(), requireContext()
src/lib/authz/permissions.ts       # Permission union type + matrix mirror (tested against DB role_permissions)
src/lib/authz/errors.ts            # typed API error responses (§7.1)
src/lib/validation/*.ts            # zod schemas per resource
src/lib/data/contacts.ts  opportunities.ts  pipeline.ts  calendars.ts  appointments.ts
src/lib/data/conversations.ts  tasks.ts  reviews.ts  reports.ts  team.ts  invitations.ts
src/lib/data/settings.ts  ai-receptionist.ts  integrations.ts  audit.ts  dashboard-adapters.ts
src/lib/platform/workspaces.ts  access-grants.ts
src/app/api/workspaces/route.ts  src/app/api/workspaces/active/route.ts
src/app/api/contacts/route.ts  src/app/api/contacts/[id]/route.ts  src/app/api/contacts/[id]/notes/route.ts
src/app/api/pipeline/route.ts  src/app/api/pipeline/stages/[id]/route.ts
src/app/api/opportunities/route.ts  src/app/api/opportunities/[id]/route.ts  src/app/api/opportunities/[id]/move/route.ts
src/app/api/calendars/route.ts  src/app/api/calendars/[id]/route.ts  src/app/api/calendars/[id]/availability/route.ts
src/app/api/appointments/route.ts  src/app/api/appointments/[id]/route.ts
src/app/api/conversations/route.ts  src/app/api/conversations/[id]/messages/route.ts  src/app/api/conversations/[id]/notes/route.ts
src/app/api/tasks/route.ts  src/app/api/tasks/[id]/route.ts
src/app/api/reviews/route.ts  src/app/api/reports/summary/route.ts
src/app/api/team/route.ts  src/app/api/team/[userId]/route.ts
src/app/api/team/invitations/route.ts  src/app/api/team/invitations/[id]/route.ts
src/app/api/invitations/[token]/route.ts  src/app/api/invitations/[token]/accept/route.ts
src/app/api/settings/workspace/route.ts  src/app/api/settings/ai-receptionist/route.ts
src/app/api/integrations/route.ts  src/app/api/audit/route.ts  src/app/api/onboarding/checklist/route.ts
src/app/api/platform/workspaces/route.ts  src/app/api/platform/workspaces/[id]/suspend/route.ts
src/app/api/platform/workspaces/[id]/reactivate/route.ts  src/app/api/platform/workspaces/[id]/access/route.ts
src/app/api/platform/access/[grantId]/route.ts  src/app/api/platform/audit/route.ts
src/app/invite/[token]/page.tsx  src/app/no-access/page.tsx  src/app/workspace-suspended/page.tsx
src/app/(platform)/layout.tsx  src/app/(platform)/platform/page.tsx  src/app/(platform)/platform/workspaces/[id]/page.tsx
src/components/WorkspaceSwitcher.tsx   # rendered inside TopBar only when the user has >1 workspace; uses existing ui.tsx styles
scripts/bootstrap-platform-admin.ts
tests/unit/permissions.test.ts  tests/unit/service-role-allowlist.test.ts  tests/unit/no-client-workspace-id.test.ts
tests/unit/no-ghl.test.ts  tests/unit/no-global-tenant-state.test.ts
tests/integration/_harness.ts  tests/integration/isolation.test.ts  tests/integration/relationships.test.ts
tests/integration/membership.test.ts  tests/integration/suspension.test.ts  tests/integration/roles.test.ts
tests/integration/invitations.test.ts  tests/integration/platform-access.test.ts  tests/integration/provisioning.test.ts
tests/integration/api-contracts.test.ts
tests/e2e/visual-parity.spec.ts        # Playwright, local only, diffs against docs/baseline/screenshots
docs/runbooks/AUTH_CUTOVER.md  docs/runbooks/ROLLBACK.md
```

### 8.2 Modified (layout and styling unchanged)

| File | Change |
| --- | --- |
| `package.json`, `package-lock.json` | add `@supabase/ssr`, `@supabase/supabase-js`, `zod`; dev: `supabase` (CLI, pinned), `@playwright/test` (pinned); scripts `test:unit`, `test:integration` (local guard), `test:e2e`, `db:reset:local` |
| `.env.example` | add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `AUTH_PROVIDER`, `INTEGRATION_KEK`, `TEST_SUPABASE_PROJECT_REFS`; remove `GHL_*`, `FAKE_CONTACT_ONLY`, `ALLOW_PRODUCTION_CONTACT_WRITES`, `FORBIDDEN_MASTER_LOCATION_ID`, `CLIENT_CONFIG_PATH` (Phase 7) and `AUTH_*_EMAIL/PASSWORD/NAME`, `AUTH_SECRET`, `AUTH_DEV_OPEN` (T6) |
| `src/middleware.ts` | Supabase `updateSession` + `getClaims`; same redirect/401 behaviour; drop GHL public paths (Phase 7) |
| `src/lib/auth/types.ts` | new `WorkspaceRole`, `legacyRoleOf()`; old helpers delegate to permissions until removed |
| `src/lib/auth/guards.ts` | `requirePageSession`/`requireApiSession` delegate to `requireContext()` |
| `src/lib/auth/session.ts`, `session-store.ts`, `session-edge.ts`, `password.ts`, `auth-me-probe.ts` | legacy path behind `AUTH_PROVIDER=legacy`; deleted at T6 |
| `src/app/api/auth/login/route.ts`, `logout/route.ts`, `me/route.ts` | Supabase implementation; contract per §7.2 |
| `src/app/(protected)/layout.tsx` | `await requireContext()` |
| `src/lib/tenant.ts` | `getWorkspaceConfig()` reads `workspace_settings`/`pipeline_stages`/`calendars` via context; remove `globalThis` cache and F&A defaults |
| `src/lib/tenant-ui.ts` | read from request context |
| `src/lib/brand.ts` | keep platform brand; fix `supportPhoneRecovered` (currently `860-337-2617`) to the confirmed number; drop GHL `clientForbiddenTerms` entries no longer relevant |
| `src/components/Sidebar.tsx` | visibility predicate → permissions (§4.3); items/order/styles unchanged |
| `src/components/TopBar.tsx` | mount `WorkspaceSwitcher` (hidden for single-workspace users) |
| `src/components/WaitingForSync.tsx`, `src/lib/ui/sync-copy.ts` | native empty-state copy ("No contacts yet — add your first contact") |
| `src/app/(protected)/dashboard/page.tsx`, `contacts/page.tsx`, `contacts/ContactsClient.tsx`, `pipeline/page.tsx`, `calendar/page.tsx`, `tasks/page.tsx`, `reviews/page.tsx`, `reporting/page.tsx`, `inbox/page.tsx` | data source → `src/lib/data/*`; add create/edit actions inside existing cards and buttons |
| `src/app/(protected)/settings/page.tsx` | Team/Staff card → `/api/team` + invitations; Integrations card → native integrations; AI Receptionist section in an existing card style; System status → DB health |
| `src/app/(protected)/onboarding/page.tsx` | native checklist (`/api/onboarding/checklist`) |
| `src/app/(protected)/support/page.tsx`, `help/page.tsx` | contact details from `/api/tenant/config`; remove CRM/GHL wording |
| `src/app/api/dashboard/*/route.ts`, `src/app/api/tenant/*/route.ts`, `src/app/api/health/route.ts` | re-backed by native data (§7.3) |
| `tests/auth.test.ts`, `authorization.test.ts`, `tenant.test.ts`, `client-facing-copy.test.ts`, `security-scan.test.ts` | updated for new auth and roles; `sync.test.ts`, `onboarding.test.ts`, `supabase-rest-auth.test.ts` replaced |

### 8.3 Deleted (Phase 7 and T6)

```
src/lib/ghl.ts  src/lib/mapping.ts  src/lib/owner-values.ts  src/lib/master-guard.ts  src/lib/leads.ts
src/lib/env.ts (GHL portions; file removed if empty)
src/lib/sync/  (all files)
src/lib/deployment/manifest-gate.ts  src/lib/deployment/validate.ts
src/lib/onboarding/load-config.ts  src/lib/onboarding/readiness.ts  src/lib/onboarding/types.ts  src/lib/onboarding/index.ts
src/app/api/ghl/health/route.ts  src/app/api/webhooks/ghl/route.ts  src/app/api/leads/route.ts
src/app/api/sync/health/route.ts  src/app/api/events/route.ts  src/app/api/onboarding/readiness/route.ts
public/ghl-custom.css
scripts/check-client-readiness.ts  scripts/client-prepare.ts  scripts/generate-client-deployment.ts  scripts/validate-client-env.ts
config/client-remap.template.json  config/examples/fake-roofing-client.json  config/examples/synthetic-ready-client.json
docs/GHL_SYNC_WEBHOOK_CONTRACT.md  docs/GHL_WORKFLOW_SYNC_MAP.md  docs/WEBHOOK_SECURITY_V1.md  → moved to docs/archive/
(T6) src/lib/auth/session.ts session-store.ts session-edge.ts password.ts auth-me-probe.ts  scripts/verify-auth-runtime.mjs
```

---

## 9. Migration order and delivery phases

### 9.1 Database migration order

| # | File | Contents | Depends on |
| --- | --- | --- | --- |
| M1 | `20261101000100_extensions_schemas.sql` | `citext`, `btree_gist` in schema `extensions`; schema `private` (usage for `authenticated` only) | — |
| M2 | `20261101000200_identity_platform.sql` | `profiles`, `platform_admins`, `workspaces` (incl. `bootstrap_owner_email`, `owner_acquired_at`), `role_permissions`, `grant_mode_permissions` (+ static rows), `platform_audit_log` | M1 |
| M3 | `20261101000300_membership_access.sql` | `workspace_members`, `member_permission_overrides`, `user_active_workspace`, `workspace_invitations`, `platform_access_grants` (`unique (workspace_id, id)`) | M2 |
| M4 | `20261101000400_authz_helpers.sql` | `private.is_platform_admin`, `active_member_role`, `active_grant_mode`, `active_grant_id`, `active_workspace_id`, `has_permission`, `can_see_workspace`, `shares_active_workspace`; generic triggers `forbid_workspace_change`, `assert_active_member`, `set_updated_at`, `reject_mutation` | M3 |
| M5 | `20261101000500_workspace_config.sql` | `workspace_settings`, `ai_receptionist_configs` (`check (enabled = false)`), `integrations` (server-controlled `status`/`capabilities`/`verified_at`; connected ⇒ verified), `integration_secrets` | M4 |
| M6 | `20261101000600_crm_core.sql` | `contacts`, `contact_tags`, `contact_notes` (author → `auth.users`, `author_grant_id` composite FK), `pipelines`, `pipeline_stages`, `opportunities` | M5 |
| M7 | `20261101000700_scheduling.sql` | `calendars`, `calendar_members`, `availability_rules`, `appointments` (overlap exclusion) | M6 |
| M8 | `20261101000800_engagement_audit.sql` | `conversations`, `messages` (author + `author_grant_id`), `tasks`, `reviews`, `activity_events`, `workspace_audit_log` (`(workspace_id, grant_id)` composite FK) | M7 |
| M9 | `20261101000900_triggers_integrity.sql` | workspace immutability, active-assignee, actor stamping (`stamp_creator`/`stamp_updater`/`stamp_author`), workspace membership lock + last-owner guard, owner-acquired marker, employee-only overrides, 12-stage invariant, stage freeze, opportunity status/stage sync, integration verification guard, append-only guards, `updated_at`, profile on new `auth.users` | M8 |
| M10 | `20261101001000_rls_policies_grants.sql` | enable + force RLS on all 31 native tables; revoke from `anon`/`authenticated`; per-table policies and column grants | M9 |
| M11 | `20261101001100_rpc_membership_invites.sql` | `request_context`, `switch_workspace`, `create_invitation`, `peek_invitation` (only RPC open to `anon`), `accept_invitation`, `revoke_invitation`, `set_member_role`, `set_member_permission`, `remove_member`, `leave_workspace`, `soft_delete_*`; grant-write audit triggers | M10 |
| M12 | `20261101001200_rpc_platform_provisioning.sql` | `platform_provision_workspace`, `platform_rotate_bootstrap_invitation`, `platform_suspend_workspace`, `platform_reactivate_workspace`, `platform_grant_access`, `platform_revoke_access`, `platform_list_workspaces`, `platform_list_audit` | M11 |
| M13 | `20261101001300_storage_reporting_views.sql` | `security_invoker` reporting view; `workspace-assets` bucket + policies (created only when `storage.buckets` exists) | M12 |
| M14 | `20261101001400_legacy_lockdown.sql` | legacy `auth_sessions` + nine `sync_*` tables: revoke `anon`/`authenticated`/PUBLIC, enable default-deny RLS (no policies), explicit `service_role` select/insert/update/delete. No data, column, or table changes. | legacy files |
| M15 | `2026MMDD000000_retire_legacy.sql` (not written) | drop `sync_*` and `auth_sessions` — **only after T6 and a verified backup** | T6 |
| M16 | `20261101001500_auth_session_platform_storage.sql` | `list_my_workspaces`, audited platform Storage change RPCs and trigger (§16) | M13 |
| M17 | `20261101001600_team_settings.sql` | team listing, atomic overrides, invitation sign-up email, config-change audit triggers (§18) | M16 |
| M18 | `20261101001700_native_crm.sql` | `save_contact`, `save_calendar`, `replace_availability`, CRM activity triggers (§19) | M17 |
| M19 | `20261101001800_platform_console.sql` | platform console RPCs (§20) | M18 |
| M20 | `20261101001900_availability_lock.sql` | `replace_availability` locks the calendar row first, so concurrent replacements serialize | M18 |
| M21 | `20261101002000_session_revocation.sql` | access requires the token's Auth session to still exist (helpers, `request_context`, PostgREST pre-request check), so logout ends reads and writes at once (§5.1) | M20 |
| M22 | `20261101002100_platform_admin_guard.sql` | platform-admin grants and revocations run in service-role functions that write the audit row in the same transaction; every change to `platform_admins` takes one advisory lock, and a statement trigger refuses any delete (direct, cascade, or truncate) that would leave zero platform admins | M21 |
| M23 | `20261101002200_booking_lock.sql` | appointment inserts and time, calendar, status or deletion changes take a per-calendar transaction lock before the exclusion constraint is checked, so simultaneous bookings of one slot fail with the overlap error (409) instead of deadlocking (40P01, previously a 503) | M22 |
| M24 | `20261101002300_invitation_authority.sql` | removing a member (or a member leaving) revokes every open invitation they created; a role change revokes the ones the new role could not issue; each revocation is audited in the same transaction | M23 |
| M25 | `20261101002400_appointment_rules.sql` | a booking that takes a slot (new, moved, or revived) must be on an active calendar, and new or moved times span at most 24 hours — checked by trigger on the stored row, so concurrent edits and direct Data API writes cannot bypass it | M24 |
| M26 | `20261101002500_integrity_round3.sql` | invitations end with any loss of their issuer's authority (member role, platform grant, or bootstrap admin status), checked under lock at acceptance; signed-in acceptance needs a confirmed email and the invitee's repeat is answered idempotently; removing a platform admin ends their grants (grant FK now on `auth.users`, history kept); bookings share-lock their calendar against deactivation; logo changes only through `set_workspace_logo`; TRUNCATE refused on audit/activity tables; the AAL1 setting removed; dead sessions see no workspaces or profile | M25 |

The numbers after M14 skip M15, which stays reserved for the destructive legacy drop. The deployable manifest is the two legacy files plus M1–M14 and M16–M26 (`docs/STAGING_CUTOVER_CHECKLIST.md` §5).

M1–M13 are additive and leave the legacy tables' structure and data untouched. M14 changes only privileges and RLS on the legacy tables; the legacy app reaches them exclusively with the server-side service-role key, which keeps full access. Rollback (`supabase/rollback/20261101_native_multi_tenant.down.sql`) reverts M1–M13 and deliberately does **not** revert M14.

The legacy migrations originally shared the 8-digit version `20260917`. They are now `20260917121316_sync_store.sql` and `20260917185155_auth_sessions.sql` (contents unchanged; mapping and reconciliation steps in `docs/MIGRATION_VERSION_MAPPING.md`). Any existing database's history is unknown: reconcile with `supabase migration list` on staging before any push — never repair remote history blindly.

### 9.2 Delivery phases

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| P0 Prerequisites | Docker Desktop + Supabase CLI locally (D1); decisions D1–D7 resolved | `supabase start` works locally — **BLOCKED** (Docker/WSL/Supabase CLI not installed); PGlite + real local PostgreSQL used meanwhile (§15) |
| P1 Schema | M1–M14 + rollback script + DB tests | Done locally: PGlite/shim and real-PostgreSQL suites green. `supabase db reset` and HTTP/JWT/Storage checks **BLOCKED** until the Supabase CLI stack runs |
| P2 Auth | Supabase auth behind `AUTH_PROVIDER`; request context; middleware | AUTH-* pass; legacy mode still passes the original 137 tests |
| P3 Read parity | Existing pages and `/api/dashboard/*` read native tables via adapters | UI-1, UI-2 visual parity; API-1 shape tests — done locally (§17): API-1, ISO, and UI-1 pass on the real stack; UI-2 run with a local harness (sidebar 0.00% on all 20 pages; differences are copy) |
| P4 Team & settings | Team, invitations, settings, AI config, integrations list inside existing Settings layout | INV-*, ROLE-*, SET-* pass — done locally (§18): INV, ROLE, MEM, SUSP, SET-1..7, browser flow, and NET-1 pass on the real stack |
| P5 Native CRUD | Create/edit on Contacts, Opportunities (move), Calendars, Tasks, Inbox notes | CRUD-* pass; no outbound calls (NET-1) — done locally (§19): CRUD-1..5, workspace switching, browser flow, and NET-1 pass on the real stack |
| P6 Platform console | `/platform` workspaces, provision, suspend, access grants, audit | PLAT-*, SUSP-* pass — done locally (§20): CON-1..9 (covering PLAT-1..3 and SUSP-1/2/5/6 through the app) pass on the real stack, including MFA and the browser flow |
| P7 GHL removal | Delete §8.3 files; env cleanup | GHL-1, GHL-2 pass; build + all tests green — done locally (§21). GHL-1/GHL-2 pass with an exact, test-enforced exception list: the read-only legacy snapshot (`src/lib/legacy/deployment.ts`, `snapshot.ts`) kept for `AUTH_PROVIDER=legacy` until T6/M15 (§21.3) |
| P8 Staging rehearsal | T3–T4 on staging | Full suite green on staging; George signs off |
| P9 Production cutover | T5, then T6 after 14 days | **Requires George's explicit approval** |

---

## 10. Acceptance tests

All integration tests run against local Supabase (or an allowlisted non-production project). `tests/integration/_harness.ts` aborts if `VERCEL_ENV` is set, if the host is not local, or if the project ref is not allowlisted. Each test creates its own users and workspaces through the provisioning RPC and invitations, with no shared fixtures.

Standard fixture: workspaces **A** and **B**. Users: `ownerA`, `adminA`, `employeeA`, `ownerB`, `employeeB`, `dual` (employee in A and B), `outsider` (no memberships), and `platform` (platform admin, AAL2 simulated locally).

### 10.1 Isolation — reads

| ID | Test |
| --- | --- |
| ISO-R1 | For **every** tenant table, `employeeA` selecting without filters returns only rows where `workspace_id = A` (table list generated from `information_schema`, so new tables are covered automatically). |
| ISO-R2 | `employeeA` selecting B's rows by known primary key returns 0 rows. |
| ISO-R3 | `GET /api/contacts/{B contact id}` as `employeeA` returns 404 `not_found`, not 403. Same for opportunities, appointments, tasks, conversations, and invitations. |
| ISO-R4 | `dual` with active workspace A sees only A data. After switching to B, it sees only B data. No request mixes the two. |
| ISO-R5 | `outsider` gets 403 `no_active_workspace` on every protected API, and zero rows from every table. |
| ISO-R6 | `integration_secrets` returns permission denied for every non-service role, including `ownerA`. |

### 10.2 Isolation — writes

| ID | Test |
| --- | --- |
| ISO-W1 | `employeeA` inserting a contact with `workspace_id = B` is rejected by RLS. |
| ISO-W2 | `ownerA` updating an A row to set `workspace_id = B` is rejected by the immutability trigger and RLS. |
| ISO-W3 | `ownerA` updating or soft-deleting a B row by ID affects 0 rows; the API returns 404. |
| ISO-W4 | Direct PostgREST insert/update on `workspace_members`, `user_active_workspace`, `workspace_invitations`, `platform_admins`, or `platform_access_grants` is denied for `authenticated`. |
| ISO-W5 | Append-only tables reject UPDATE/DELETE for every role except the migration owner. |

### 10.3 Forged identifiers

| ID | Test |
| --- | --- |
| ISO-F1 | `workspaceId` / `workspace_id` injected into JSON body, query string, `x-workspace-id` header, or a cookie is ignored. Created rows land in the server-resolved workspace. Static test `no-client-workspace-id` passes. |
| ISO-F2 | `POST /api/workspaces/active { workspaceId: B }` as `employeeA` returns 403, and `user_active_workspace` is unchanged. |
| ISO-F3 | A forged or tampered Supabase JWT, an expired JWT, or a JWT signed by another project returns 401 on APIs and a 307 to `/login` on pages. |
| ISO-F4 | A legacy `fna_session` cookie is ignored in `AUTH_PROVIDER=supabase` mode. |
| ISO-F5 | A random UUID, or a valid UUID from B, used as a `contactId`/`stageId`/`calendarId`/`assignedUserId` in an A mutation returns 422/404 with no write. |

### 10.4 Cross-workspace relationships

| ID | Test |
| --- | --- |
| REL-1 | An opportunity in A referencing a contact in B fails with an FK violation (DB) and a 404/422 (API). |
| REL-2 | An opportunity in A with a stage from B's pipeline fails. A stage from a different pipeline in A also fails. |
| REL-3 | An appointment in A with a calendar from B fails; with a contact from B fails; with an opportunity from B fails. |
| REL-4 | A task, conversation, contact owner, calendar member, or AI escalation target assigned to `employeeB` (not in A) fails. |
| REL-5 | Assigning a **removed** A member to a new or updated record fails (active-member trigger). Existing historical rows remain readable. |
| REL-6 | A contact tag or note referencing a contact in B fails. |
| REL-7 | Overlapping booked appointments on the same calendar fail (409). The same time on different calendars succeeds. |

### 10.5 Removed memberships

| ID | Test |
| --- | --- |
| MEM-1 | After `ownerA` removes `employeeA`, the removed user's **still-valid JWT** gets 0 rows from every table on the next query, and 403 `no_active_workspace` from APIs, without waiting for token expiry. |
| MEM-2 | Removal unassigns the user from open opportunities, tasks, conversations, and calendar memberships in the same transaction, and writes an audit row. |
| MEM-3 | A removed user cannot `switch_workspace` back to A. |
| MEM-4 | Re-inviting a removed user and accepting reactivates the same membership row (no duplicate), with the role from the new invitation. |

### 10.6 Suspended workspaces

| ID | Test |
| --- | --- |
| SUSP-1 | After `platform` suspends A, all A members get 0 rows and 423 `workspace_suspended` from APIs. Pages redirect to `/workspace-suspended`. |
| SUSP-2 | Writes in a suspended workspace fail for all members, including the owner. |
| SUSP-3 | Accepting an invitation to a suspended workspace fails. |
| SUSP-4 | B is unaffected while A is suspended (same `dual` user can switch to B). |
| SUSP-5 | `platform` with no grant has no access. With a `read` grant it can read A and is audited. A `write` grant on a suspended workspace is rejected. |
| SUSP-6 | Reactivation restores member access with no data loss, and both actions are in `platform_audit_log`. |

### 10.7 Unauthorized role changes

| ID | Test |
| --- | --- |
| ROLE-1 | `employeeA` cannot change any role, remove anyone, or invite anyone (403, DB unchanged). |
| ROLE-2 | `adminA` cannot promote anyone to admin or owner, demote or remove an owner or another admin, or invite admins or owners. |
| ROLE-3 | `adminA` can invite and remove employees and edit employee overrides. Overrides cannot grant `team.*` or `integrations.manage`. |
| ROLE-4 | No user can change or remove their own membership through `set_member_role`/`remove_member`. |
| ROLE-5 | Demoting or removing the last active owner fails (API and direct SQL via the trigger). With two owners, one may be demoted. |
| ROLE-6 | `ownerB` cannot change any membership in A. |
| ROLE-7 | `platform` with a `write` grant cannot change roles or manage integration credentials. |
| ROLE-8 | Every successful role change writes `workspace_audit_log` with actor, before, and after. |

### 10.8 Invitations

| ID | Test |
| --- | --- |
| INV-1 | An invitation accepted once cannot be accepted again (410 `invitation_used`), including two concurrent accept calls (exactly one succeeds). |
| INV-2 | An expired invitation returns 410 `invitation_expired`. Creating one with expiry beyond 7 days fails. |
| INV-3 | A revoked invitation returns 410 `invitation_revoked`. |
| INV-4 | Accepting with a signed-in user whose email differs from the invitation fails. |
| INV-5 | An invitation with role `platform_admin` (or any value outside owner/admin/employee) is rejected by the CHECK constraint and by validation. No code path inserts into `platform_admins` except A2. |
| INV-6 | The raw token is never stored. The DB holds only `sha256(token)`, and `token_hash` is not selectable by `authenticated`. |
| INV-7 | Creating an invitation sends no email or SMS: the outbound network spy records zero calls besides Supabase (NET-1). |

### 10.9 Platform access and provisioning

| ID | Test |
| --- | --- |
| PLAT-1 | `platform` without a grant reads 0 rows from A. After `grant_access(A, 'read', reason, 60)`, reads succeed and writes fail. After revoke or expiry, access ends on the next query. |
| PLAT-2 | Grant creation, revocation, and every write under a `write` grant are audited with `grant_id`. |
| PLAT-3 | A non-platform user calling any `public.platform_*` RPC or `/api/platform/*` gets 403. An AAL1 session gets 403 unless the local-only override is on. |
| PROV-1 | Provisioning creates exactly: 1 workspace, 1 settings row, 1 AI config (disabled), 1 pipeline, **12 stages** with the exact names, positions, and kinds in §5.3, and 1 owner invitation. It creates **0** contacts, opportunities, appointments, calendars, conversations, messages, tasks, reviews, members, and integrations. |
| PROV-2 | Calling again with the same `provisioningKey` and same inputs returns the same workspace ID, with no duplicate rows. Same key with different inputs returns 409. |
| PROV-3 | Ten concurrent calls with the same key produce exactly one workspace. |
| PROV-4 | A failure injected after stage insertion (test hook) leaves zero rows for that key (transactional). |
| PROV-5 | A second workspace's stage IDs are distinct from the first's, and neither can reference the other. |

### 10.10 Auth, API, UI, and GHL removal

| ID | Test |
| --- | --- |
| AUTH-1 | Login/logout/me contracts per §7.2. A wrong password returns 401 with a generic message. Supabase rate limiting returns 429. |
| AUTH-2 | With `AUTH_PROVIDER=legacy`, the original 137 unit tests still pass (until T6). |
| API-1 | `/api/dashboard/*` responses validate against the pre-migration TypeScript shapes. |
| UI-1 | As the owner, all 15 sidebar destinations plus `/support`, `/training`, `/privacy`, `/terms` return 200 with no page errors. Setup is hidden for admins and employees; Resources is hidden for employees. Direct navigation to a hidden route redirects to `/dashboard`. |
| UI-2 | Playwright visual diff against `docs/baseline/screenshots/` for the same empty-workspace state. Sidebar, top bar, card layout, fonts, and colours match within threshold. Differences are limited to approved copy changes (empty-state wording, removed CRM/GHL text). |
| NET-1 | During the integration and e2e suites, a fetch/undici interceptor allows only the local Supabase host. Any other outbound request fails the run. |
| GHL-1 | `rg -i "ghl\|highlevel\|leadconnector\|location_id"` over `src/`, `scripts/`, `public/`, and `supabase/migrations/2026110*` returns no matches. |
| GHL-2 | The build succeeds with no `GHL_*` variables defined, and no code reads them. |
| GLOBAL-1 | No `globalThis` tenant/session/store state in `src/`. |
| SR-1 | Service-role allowlist static test passes (§6.4). |

---

## 11. Rollback strategy

- **Database:** M1–M13 are additive. M14 only tightens privileges and RLS on the legacy tables (`sync_*`, `auth_sessions`); their data stays untouched until M15. Local and staging rollback uses `supabase/rollback/20261101_native_multi_tenant.down.sql` (reverts M13 → M1; M14 is intentionally kept). Production is never rolled back by dropping schema; it is rolled back by flipping the app flag.
- **Application:** `AUTH_PROVIDER=legacy|supabase`. Rolling back means setting `legacy` and promoting the previous Vercel deployment (`release` @ `9c189f8`, or the last legacy-compatible build). The legacy env credentials are kept until T6.
- **Data:** native data written after cutover is not back-ported to the legacy store. If rollback happens after real use, export native tables (`pg_dump --data-only` of the M-series tables) before flipping, so they can be restored on the next forward attempt.
- **Point of no return:** T6/M14. These require a verified backup restore test on staging, 14 stable days, and George's written approval.
- **Per-phase:** each phase merges to `feat/native-multi-tenant` only with its tests green. Nothing merges to `release` or deploys without approval.

---

## 12. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Misconfigured RLS policy on a new table | Cross-tenant leak | ISO-R1 enumerates all tables from `information_schema`; `force row level security`; default-deny grants |
| `security definer` function bug | Privilege escalation | `search_path = ''`, fully-qualified names, explicit `auth.uid()` checks, dedicated RPC tests |
| Service-role misuse | RLS bypass | Allowlist static test; key only in `admin.ts`; never in edge/middleware |
| JWT remains valid after removal or suspension | Stale access | DB-evaluated `active_workspace_id()` per statement (MEM-1, SUSP-1); `getUser()` on sensitive mutations |
| No local Docker / Supabase CLI today | PostgREST, GoTrue/JWT, and Storage behaviour unverified | P0 prerequisite (D1). Meanwhile: PGlite shim suite + real local PostgreSQL concurrency suite (§15) |
| Supabase project pauses on the free tier (happened before) | Outage | D5: paid Supabase plan required before production cutover (no purchase made) |
| Migration history mismatch (legacy files renamed from shared version `20260917`; remote history unknown) | Failed `db push` | Reconcile per `docs/MIGRATION_VERSION_MAPPING.md` on the separate staging project (D4) first |
| Legacy `sync_*` tables were reachable through the public Data API (RLS off, default grants) | Data exposure | M14 legacy lockdown (finding 1) |
| Visual regressions while adding create/edit | UI drift | UI-2 visual diff; reuse `src/components/ui.tsx` primitives only |
| Auth cutover locks users out | Downtime | Flag rollback; staging rehearsal T3–T4; legacy creds retained until T6 |
| Scope creep (AI receptionist runtime, outbound messaging, payments) | Delay | Explicitly out of scope; config-only in this program |

---

## 13. Out of scope (this program)

AI receptionist runtime and telephony, outbound SMS/email/calls, real invitation emails, automations engine, marketing sends, payments/Stripe, data import from GHL, custom domains per workspace, billing. (Native public lead intake moved to a later phase — D3.)

## 14. Decisions (resolved as instructed by the GC)

| ID | Decision | Resolution |
| --- | --- | --- |
| D1 | Integration test environment | **Local Docker + Supabase CLI.** Not yet installed on this machine (BLOCKED); PGlite and real local PostgreSQL cover what they can (§15). |
| D2 | What provisioning seeds | **Configuration plus exactly 12 stages.** No calendars, no business records, no members. |
| D3 | Native public lead intake | **In scope for a later phase** (not P1/P2). |
| D4 | Staging | **A separate staging Supabase project, later.** Not created; no purchase or project creation in P1. |
| D5 | Production plan | **Paid Supabase is required before production cutover.** No purchase made. |
| D6 | Owners and legacy users | **George is platform super-admin and F&A workspace owner.** Legacy users receive no automatic membership. |
| D7 | Support phone | **781-964-0654.** Code change deferred to the UI phase. |

## 15. P1 implementation record

### 15.1 Files

Migrations `supabase/migrations/20261101000100…001400_*.sql` (M1–M14, §9.1); rollback `supabase/rollback/20261101_native_multi_tenant.down.sql`; tests `tests/db/` (PGlite + Supabase shim), `tests/db-real/` (real local PostgreSQL), `tests/supabase-stack/` (real local Supabase stack), `tests/stack-helpers.test.ts`, `tests/run-tests.test.ts` + `tests/fixtures/runner/` (runner self-test); runner `scripts/run-tests.mjs`; local stack config `supabase/config.toml` (TOTP MFA on, seed off, unused services off). Dev dependencies (exact versions): `@electric-sql/pglite` 0.5.14, `embedded-postgres` 18.6.0-beta.19 (PostgreSQL 18.6 binaries; every published version carries a beta tag), `pg` 8.23.1, `@types/pg` 8.23.1, `supabase` 2.122.0 (CLI). No application, auth, UI, sidebar, or production files changed.

### 15.2 Test environments (reported separately; never conflated)

| Environment | What it is | What it proves | What it cannot prove |
| --- | --- | --- | --- |
| **PGlite + shim** (`npm run test:db`) | PostgreSQL 18.6 in WASM, one connection. `tests/db/supabase-local-shim.sql` creates `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()/jwt()`, Supabase-shaped `storage.buckets`/`storage.objects`/`storage.foldername` (owned by a separate storage admin role), Supabase default privileges, and a non-superuser `migration_owner` with BYPASSRLS (like Supabase's `postgres`). Requests are simulated with `set local role` + `request.jwt.claims`. | Migrations apply/roll back; RLS, grants, constraints, triggers, RPC logic, attribution | Concurrency; real PostgREST, GoTrue JWT verification, Storage |
| **Real local PostgreSQL** (`npm run test:db:concurrency`) | Plain PostgreSQL 18.6 (embedded binaries, `127.0.0.1`, random port, throwaway data dir), same shim and migrations, independent `pg` sessions. Requires the system-wide Microsoft VC++ 2015-2022 x64 runtime (reports BLOCKED without it). | Membership-lock serialization under true concurrency (finding 2), including a negative control | Anything Supabase-specific |
| **Real Supabase local stack** (`npm run test:stack`, `tests/supabase-stack/`) | Supabase CLI 2.122.0 on Docker, PostgreSQL 17; each run creates an isolated disposable project copy in the OS temp dir (random `fna-disposable-*` id, ports +1000, marker), applies migrations with `supabase start` + `db reset --local` only after `assertDisposable` passes, and destroys only its own volumes; real GoTrue sign-ups, TOTP MFA, JWTs through PostgREST and Storage | CLI migration apply; profile trigger; forged/expired/unsigned JWT rejection; AAL1 vs AAL2 platform access; RLS isolation; forged attribution; revoked membership; suspension; platform grants; Storage policies; legacy lockdown | — **BLOCKED** on this machine: Docker engine cannot start (firmware virtualization off; Virtual Machine Platform not enabled) |

Supabase PostgreSQL versions are 15/17; the PGlite and real-PostgreSQL suites ran on 18.6. The stack suite runs on 17 (config `major_version = 17`) and covers version-specific differences once Docker works.

### 15.3 Security review findings (Codex) — resolution and regression tests

All in `tests/db/security-findings.test.ts` unless noted.

| # | Finding | Resolution | Regression tests |
| --- | --- | --- | --- |
| 1 | Legacy `sync_*` / `auth_sessions` exposed | M14: revoke `anon`/`authenticated`/PUBLIC, enable RLS with no policies, explicit `service_role` CRUD; no data change | Pre-lockdown exposure demonstrated; data inserted before M14 survives; RLS on, 0 policies; no grants; anon/authenticated refused on all 10 tables; service role CRUD works; migration has no data-changing statements |
| 2 | Concurrent owner removals could leave no owner | `private.lock_workspace_membership(ws)` (`for no key update` on the workspace row) taken before any read/write in `set_member_role`, `remove_member`, `leave_workspace`, `accept_invitation` (workspace lock before invitation lock), and bootstrap rotation; explicit `private.assert_not_last_owner` recheck under the lock; `guard_last_owner` trigger also locks | Static: lock precedes first write in all five RPCs; recheck after lock. Sequential last-owner test. **Real PostgreSQL** (`tests/db-real/concurrency.test.ts`): simultaneous leaves, mutual removals, mutual demotions, leave-during-removal each leave exactly one owner and the second session is observed blocked on the lock; control with the lock disabled leaves **zero** owners; ordinary inserts are not blocked by the lock |
| 3 | Nested PGlite transactions deadlocked | Harness guard: nested `asUser`/`asAnon`/`asServiceRole` and superuser `db.query/exec/transaction` during a session reject immediately with `NestedSessionError`; each session bounded by `SESSION_TIMEOUT_MS` (20 s); suites run with `--test-timeout` | Nested calls reject in < 2 s and the DB stays usable; timeouts asserted in runner config |
| 4 | No recovery for a lost bootstrap invitation | `platform_rotate_bootstrap_invitation(ws, reason)`: platform admin + AAL2, reason ≥ 10 chars, workspace lock, refused once `owner_acquired_at` is set or any owner row exists; revokes all open owner invitations and issues one to `bootstrap_owner_email` in one transaction; platform + workspace audit | Non-admins, AAL1, anon refused; old token revoked (`peek` = revoked, accept fails); exactly one open owner invitation; audits; injected failure leaves the current invitation untouched; new token works; refused after owner joins and for established workspaces |
| 5 | Platform write-grant holders could not author notes/messages | Author FK → `auth.users`; `author_grant_id` with composite FK; `private.stamp_author` sets the author to `auth.uid()` and requires an active member (grant id null) or a live **write** grant (grant id recorded). Assignee/owner columns still require active membership | Member authorship; write-grant authorship of notes and messages attributed to the grant; write-grant holder still cannot be an assignee/contact owner; read grant, no grant, revoked grant, removed member all refused |
| 6 | Actor fields client-controlled | No client grant on `created_by`, `updated_by`, `connected_by`, author, or grant columns (forged values are rejected with `permission denied`); triggers stamp them from `auth.uid()`; `created_by`/author immutable on update | Forged `created_by` rejected on contacts, opportunities, appointments, tasks, with stamped values verified; `created_by` unchanged by privileged update; `updated_by` stamped on settings and AI config; author/grant/`connected_by` not writable (also updated tests in `isolation.test.ts`) |
| 7 | Audit `grant_id` could reference another workspace's grant | `platform_access_grants unique (workspace_id, id)`; composite FKs `(workspace_id, grant_id)` on `workspace_audit_log` and `(workspace_id, author_grant_id)` on notes/messages | Catalog check for exactly these composite FKs and no single-column grant FK; cross-workspace audit row and note rejected even for the superuser |
| 8 | Clients could mark integrations connected / enable AI | Client grants on integrations limited to `(workspace_id, provider, config)` insert and `(config)` update; `status`/`capabilities`/`verified_at` server-controlled with `check (status <> 'connected' or verified_at is not null)`; trigger resets verification on client config changes; AI `check (enabled = false)` and no client grant on `enabled` | Client writes to status/capabilities/verified_at refused; client insert lands disconnected; service role cannot connect without verification; config change clears verification; enabling AI refused for client, service role, and superuser even with a verified voice integration |

Also added: architecture guard (no `organizations`/`organization_id`/`org_id` in migrations); synthetic fixture names; runner self-tests.

#### Second review (Codex) — four remaining findings

| # | Sev | Finding | Resolution | Regression tests |
| --- | --- | --- | --- | --- |
| R2-1 | P1 | Authorization evaluated before the workspace lock (stale authority after a concurrent demotion/removal) | `private.recheck_authority(ws, permission, member_only)` runs immediately after `lock_workspace_membership` in `set_member_role`, `remove_member`, `leave_workspace`, `set_member_permission`, `create_invitation`, `revoke_invitation` (the latter three now also take the lock); bootstrap rotation re-checks platform admin after its lock. Pre-lock checks remain as a fast fail | **Real PostgreSQL**: demotion-versus-promotion race refused with `forbidden` (caller ends as admin, target stays employee, one owner); control with only the re-check removed reproduces the bug (demoted caller promotes to owner); removed owner cannot create an invitation after waiting. **PGlite**: each RPC's re-check directly follows the lock and precedes all membership reads/writes; helper not client-callable |
| R2-2 | P2 | A real failure could be reported as BLOCKED when output also contained `BLOCKED:` | Runner classifies each TAP root-cause failure (`failureType` other than `cancelledByParent`/`subtestsFailed`); BLOCKED only when every root cause's error starts with `BLOCKED:` and is not an assertion. Any real failure → FAIL | Fixtures: blocked + failing test → FAIL; blocked + failing hook (all cancelled, fail 0) → FAIL; assertion message containing `BLOCKED:` → FAIL; pure blocker → BLOCKED. The previous runner reported all three as BLOCKED |
| R2-3 | P2 | Platform-granted Storage mutations unaudited | `private.audit_grant_storage_write()` trigger on `storage.objects` (insert/update/delete, `workspace-assets` only): when the caller is not a member but holds a live grant, writes `workspace_audit_log` with actor, workspace, `grant_id`, action `storage.object_<op>`, target `bucket/path`, metadata `{operation, bucket_id, object_path[, previous_object_path]}`. Rollback drops the trigger | **PGlite** (shim now has Supabase-shaped `storage.buckets/objects/foldername`): insert/rename/delete under a write grant audited with all fields; member uploads not audited; read grant can view, cannot mutate, nothing audited; revoked grant refused. Storage policy isolation (owner, other workspace, employee, anon, outsider, no-folder path). **Superseded by decision A**: the real Storage API commits rows as `service_role`, so write policies now also require active membership; write grants can view but not insert/update/upsert/rename/delete (PGlite, real PostgreSQL, stack PASS); the trigger is a tested backstop |
| R2-4 | P2 | Stack suite could reset an existing (developer) local stack | Suite builds an isolated disposable copy in the OS temp dir: random `fna-disposable-*` project id (own Docker volumes), ports +1000, marker file, only config + migrations copied (no link/env). `assertDisposable` (started by this run, temp location, marker, project id, no remote link, shifted local ports) must pass before `db reset`; volumes destroyed only for the run's own project | Unit tests for every guard (wrong ports, non-local host, missing/mismatched marker, real project id, linked project, workdir outside temp, not started here) and a source check that reset follows the guard and every CLI call uses the disposable workdir |

#### Second review — coverage follow-up (Codex rerun confirmed unit 155, PGlite 149, concurrency 10)

No schema or RPC changes; tests only.

| Area | PGlite + shim | Real PostgreSQL (independent sessions, real clock) | Real Supabase stack |
| --- | --- | --- | --- |
| Grant expiry | Existing timestamp-shifted test | One-minute write grant issued by RPC; after the database clock passes `expires_at` (grant row untouched, never revoked): no contact reads/writes, no Storage read/update/delete/insert, `request_context` has no grant or workspace, switching refused; audit holds exactly the four in-window actions | Same through PostgREST and the Storage API (BLOCKED) |
| Storage update/upsert | Owner update and `insert … on conflict do update`; employee, other workspace, read grant refused; write-grant update/upsert audited with exact action, target, grant, path (no `previous_object_path`); member changes not audited | Write-grant insert and update audited exactly (expiry test) | `PUT` and `x-upsert` by owner; other workspace refused; write-grant update/upsert audited exactly; refused after revocation (BLOCKED) |
| Storage after revocation | Revoked write grant: no read/update/upsert/delete/insert, nothing audited; removed admin loses read and write; removed employee loses read; suspension ends member access, read grant still views, reactivation restores | — | Removed employee can no longer read the workspace asset (BLOCKED) |
| Permission overrides | Allow `settings.write` → employee writes assets, cleared → refused; deny `contacts.write`/`contacts.read` enforced in RLS; allow `contacts.delete` honoured by `soft_delete_contact`; overrides scoped to their workspace; promotion clears them and demotion does not restore; removal clears them and re-invite starts at base; only `team.manage_overrides` holders in the target's workspace (not employees, other workspaces, or platform grants); no direct client writes; other workspaces cannot read them; changes audited with target and exact permission | Owner demoted to employee while waiting cannot set an override; override vs promotion in either order never leaves an override on an admin | Allow/clear `settings.write` and deny/clear `contacts.write` through Storage and PostgREST; employee cannot set overrides; `team.*` override refused (BLOCKED) |
| Concurrent provisioning | — | Same key + inputs: second waits, returns the same workspace with `created = false` and no token (1 workspace, 12 stages, 1 invitation); same key + different inputs → `conflict`; same slug + different keys → `conflict`, no partial workspace | Two simultaneous identical requests settle to one workspace (BLOCKED) |
| Concurrent invitations | — | Same token from two sessions → one membership, other `invitation_used`; two invitees both join; revoke-first → `invitation_revoked`; accept-first → revoke `conflict`; rotate-first → old token revoked, new token works; accept-first → rotation `conflict`, no new invitation; two rotations → exactly one open owner invitation, only the last token works | Simultaneous double acceptance → one membership (BLOCKED) |
| Contact-write audit | Exactly one grant-linked row besides `platform.access_granted`: `contacts.insert`, actor, `platform_admin`, target = the new contact id | Exact (expiry test) | Same exact assertion (BLOCKED) |

Grant expiry is evaluated with `now()`, i.e. at transaction start; a single PostgREST request is one short transaction, so a grant cannot outlive its expiry by more than one in-flight request.

### 15.4 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| `npm test` (runner: unit + db + realpg + stack) | Node 24.20.0 | Exit 0 after decision A — unit 155/155, db 170/170, realpg 24/24, stack 17/17 PASS (the run before decision A was stack 15/17: R2-3, below) |
| Unit suite (original 137 + 9 runner self-tests + 9 stack-helper tests: TOTP vectors, HS256, disposable-stack guards) | Node | PASS 155/155 |
| DB suite: migrations 9, isolation 42, membership 19, platform 22, security findings 38, review round 2 21, review coverage 19 | PGlite + shim (incl. storage tables) | PASS 170/170 |
| Concurrency suite: owner/role/override races 13, provisioning 3, invitations/rotation 7, clock expiry 1 | Real local PostgreSQL 18.6, independent sessions, system VC++ runtime | PASS 24/24 (incl. two negative controls; expiry test waits ~62 s on the database clock) |
| `tsc --noEmit -p .` (app) | — | PASS |
| `tsc` over `tests/db`, `tests/db-real`, `tests/supabase-stack`, runner tests (bundler resolution, strict) | — | PASS |
| `npm run build` | Next.js 15.5.25 | PASS |
| Lint | — | Not available (no lint script/config) |
| `supabase start` + `supabase db reset --local` (CLI applies all 16 migrations) | Real Supabase local stack (disposable, Docker 29.9.2) | PASS |
| GoTrue sign-up → profile trigger; forged/expired/unsigned JWTs; AAL1 vs TOTP AAL2 platform RPCs | Real Supabase local stack | PASS |
| RLS isolation, forged attribution, revoked membership, suspension, platform grants, exact contact-write audit over PostgREST | Real Supabase local stack | PASS |
| Storage policies: workspace folder isolation, PUT/upsert, removed member, suspension, overrides | Real Supabase local stack | PASS |
| Permission overrides, concurrent provisioning and double acceptance, one-minute clock expiry (isolated workspace) | Real Supabase local stack | PASS |
| Legacy tables closed to anon/authenticated over PostgREST; service role retained | Real Supabase local stack | PASS |
| Platform write grant through the Storage API: upload, PUT, upsert, delete refused; GET allowed; no storage audit rows; revoked grant cannot read | Real Supabase local stack | PASS (2 tests; R2-3 decision A) |

`npm test` exit codes: 0 all suites pass; 1 any failure, cancellation, skip/todo, missing summary, or fewer tests than the suite minimum; 2 nothing failed but a suite was BLOCKED (never reported as PASS).

**R2-3 reopened (real Storage API).** A diagnostic trigger on a disposable stack showed that the Storage API checks permissions with the caller's JWT in a transaction it rolls back, then commits the row write as `service_role` (session `supabase_storage_admin`, claims `role = service_role`, no `sub`). In the committed write `auth.uid()` is null, so `audit_grant_storage_write` skips it, and anything written during the permission check is rolled back. Storage stamps `owner_id` from the verified JWT on insert and update, so those can be attributed; on delete the deleter's identity is not present (`old.owner_id` is the last writer). RLS enforcement itself is correct (other workspaces, employees, read and revoked grants are refused).

**R2-3 resolution (decision A).** `workspace_assets_insert/update/delete` now require an active membership in the folder's workspace in addition to `settings.write`; a platform write grant alone cannot insert, update, upsert, rename, or delete objects, so no unaudited grant-made Storage change is possible. `workspace_assets_read` is unchanged: valid read and write grants still view assets. Platform Storage changes will go through an audited server endpoint built with P2 authentication. `audit_grant_storage_write` remains as a backstop for any write made in a caller's own database context.

### 15.5 Remaining blockers before P2 / staging

1. ~~**Audited platform Storage endpoint** (R2-3, decision A)~~ — delivered in P2 (§16.2).
2. **Legacy migration history reconciliation** (cutover prerequisite): files renamed to unique versions (`docs/MIGRATION_VERSION_MAPPING.md`); history of any existing database is unknown and must be reconciled with `supabase migration list` on staging before any push. No remote repair was performed.
3. **Staging project (D4) and paid plan (D5)** not created/purchased — by instruction.
4. Phone number change (D7) and all theme/navigation-preserving UI work wait for the UI phase.

## 16. P2 implementation record (authentication)

Local only: nothing pushed, deployed, or applied to a hosted project; no invitations or outbound messages. `AUTH_PROVIDER` defaults to `legacy`, so existing deployments behave exactly as before.

### 16.1 Files

| Area | Files |
| --- | --- |
| Provider and config (edge-safe) | `src/lib/auth/provider.ts` — `authProvider()` (`legacy` default, `supabase`, anything else = misconfigured → fail closed 503), `supabaseAuthConfig()` (server-only `SUPABASE_URL` + `SUPABASE_ANON_KEY`/`SUPABASE_PUBLISHABLE_KEY`; no `NEXT_PUBLIC_*`), httpOnly/SameSite=Lax cookie options (Secure in production) |
| Clients | `src/lib/supabase/server.ts` (per-request clients, pending cookies applied to responses), `src/lib/supabase/admin.ts` (A5 only) |
| Request context | `src/lib/authz/evaluate.ts` (pure, edge-safe: context shape, §7.1 denial order, page permissions, denial redirects), `src/lib/authz/context.ts` (getClaims → `rpc request_context` with the user's JWT; API and page variants; `getUser()` re-check for sensitive mutations) |
| Middleware and guards | `src/middleware.ts` (provider dispatch; legacy body unchanged), `src/lib/auth/guards.ts` (provider dispatch; legacy bodies unchanged; workspace role → legacy role mapping owner→OWNER, admin→ADMIN, employee→CLIENT) |
| Routes | `/api/auth/login`, `/api/auth/logout`, `/api/auth/me` (supabase branches), `/api/workspaces` (GET), `/api/workspaces/active` (POST), `/api/platform/workspace-logo` (PUT/DELETE) |
| Pages and UI | `/no-access`, `/workspace-suspended` (`src/components/AccessNotice.tsx`, same card layout as the login page); Sidebar Setup/Resources use `onboarding.read`/`library.read` when permissions are present (labels, order, icons unchanged) |
| Database | `supabase/migrations/20261101001500_auth_session_platform_storage.sql` (M16): `list_my_workspaces()`, `platform_storage_change_requested()`, `platform_storage_change_claimed()` (returns the operation token) and `platform_storage_change_finished(request, actor, operation_returned)` (service role only), `private.platform_storage_changes`, `private.platform_storage_tombstone()`, and the `platform_storage_change_applied` trigger on `storage.objects`; rollback drops them first. M16 was amended in place for the review (never pushed or applied outside disposable local stacks) |
| Tests | `tests/p2-auth.test.ts` (unit, 27), `tests/p2-review-fixes.test.ts` (unit, 23, against the local fake in `tests/helpers/fake-supabase.ts`), `tests/db/p2-auth-rpcs.test.ts` (PGlite, 17), `tests/db-real/concurrency.test.ts` "platform Storage operations and their recovery never race" (real PostgreSQL, 4), `tests/supabase-stack/stack.test.ts` nested "the app with AUTH_PROVIDER=supabase (P2)" (11), helpers in `tests/supabase-stack/stack.ts` (`startApp` builds and starts the app on a local port against the disposable stack with a scrubbed environment; `appFetch`, `appLogin`, `sessionCookie`) |

### 16.2 Behaviour

- **Middleware (supabase mode):** `getClaims()` first (verifies and refreshes the session), never reads `fna_session` (ISO-F4). Signed out: protected pages 307 → `/login?next=…`, protected APIs 401 `{code:"unauthenticated"}`. Signed in, protected pages: `rpc request_context` is evaluated **before rendering** — no workspace → 307 `/no-access`, suspended (no read grant) → 307 `/workspace-suspended`, missing `onboarding.read`/`library.read` → 307 `/dashboard?denied=1`, database unavailable → 503. Layout and page guards repeat the check.
- **Why the middleware page check exists:** the first real-stack run showed that a layout `redirect()` streams as HTTP 200 (root `loading.tsx`) while Next renders the page in parallel, so `/dashboard` content was sent to an outsider and to a just-removed member. Pages with their own guard (`/onboarding`, `/library`) did not leak. Deciding access in middleware fixed it; the stack test now requires a real 307 and asserts no page content is sent.
- **Error codes (§7.1):** 401 `unauthenticated`, 403 `forbidden`, 403 `no_active_workspace`, 423 `workspace_suspended`, 503 `auth_misconfigured`/`unavailable`, 429 `rate_limited`, 422 `validation_failed`.
- **JSON bodies:** every JSON endpoint reads the body with `readJsonObject` (`src/lib/http/json-body.ts`): invalid JSON, `null`, arrays, and primitives are rejected, and fields are type-checked (login 400, workspace switch and recovery 422).
- **Session refresh:** `requireApiContext` applies refreshed or cleared session cookies to its own denial responses, and every Supabase-mode route applies them to its other responses — including `/api/auth/me`, which middleware does not refresh because it is public.
- **Login:** generic 401 "Invalid credentials" for wrong password and unknown email; Auth 429 → 429 `rate_limited`; Auth unreachable or 5xx → 503 (not reported as bad credentials); `Cache-Control: private, no-store`.
- **Logout:** `signOut({scope:"local"})`, clears every `sb-*-auth-token(.N)` cookie; other sessions of the same user continue. Per §5.1, a copied cookie of the logged-out session still passes reads until its access token expires (local default 1 hour; observed on the real stack), because `getClaims()` and PostgREST verify the JWT, not the session row. Sensitive mutations call `getUser()` and refuse it (observed: logged-out AAL2 session → 401 on the platform Storage endpoint, nothing recorded). Open decision for review: a session-row check in `request_context` would make logout immediate for every app request.
- **Platform Storage endpoint (R2-3, decision A):** `PUT/DELETE /api/platform/workspace-logo` for an AAL2 platform admin who is not a member and holds a live `write` grant; fresh `getUser()`; workspace from the context only; path fixed to `<ws>/logo.(png|jpg|webp)`, PNG/JPEG/WebP up to 2 MB. Read grants, members, AAL1 sessions, logged-out sessions, and revoked grants are refused. Flow (after the P2 reviews, §16.5 and §16.6):
  1. `platform_storage_change_requested` (caller's JWT) re-checks admin, grant mode, and path, and writes a `requested` audit row.
  2. `platform_storage_change_claimed` (service role only) claims the request for execution and returns a random operation token that only the server sees (clients cannot read `private.platform_storage_changes`); only one unfinished change per object (`409 change_pending` until the previous one has an outcome). Unclaimed requests — e.g. made by calling the RPC directly — can never receive an outcome.
  3. The service-role write carries the token: an upsert stores it in the object's `user_metadata.platform_operation`; a delete is a Storage move to `<ws>/.platform-trash/<request id>-<token>.<ext>` (one row update) followed by best-effort removal of that tombstone. The `platform_storage_change_applied` trigger on `storage.objects` marks the request applied in the same transaction that commits the write — only for a write whose token, path, and operation match the open claim. A real-stack probe showed that the Storage API commits **every** write — a member's or the server's — as `service_role` with no subject, and that a service upsert keeps the existing owner, so the session cannot identify the uploader; the token does. Only the server knows a claim's token until its own write has committed (the token then appears in the object's metadata or tombstone name, when that outcome is already `succeeded`), so any write without it — including every member write while the request is pending — is never attributed. A token carried over unchanged from the previous row version (e.g. a re-upload that keeps metadata) is not a new write; a newly written token of a finished request is refused.
  4. `platform_storage_change_finished(request, actor, operation_returned)` (service role only) records exactly one `succeeded` (this operation's write committed) or `failed` row (`recorded_by: server`, `resolved_by: operation|recovery`). `operation_returned` is true only when this server's Storage call got an HTTP response. Without it (timeout, dropped connection, recovery request) and while the operation is not applied and its 2-minute lease (above the 30 s request timeout) has not expired, nothing is recorded and the claim is kept: the route answers `409 operation_in_progress` with `requestId` and `Retry-After: 120`. Recording an outcome closes the token under the claim row lock that the trigger also takes, so a write still in flight either commits first (and the outcome is `succeeded`) or is refused afterwards (`platform_operation_closed`) and never takes effect. Retried twice on failure; idempotent.
  5. If completion itself fails: `503 audit_pending` with `requestId`; the request stays pending and blocks further changes to that object until `POST /api/platform/workspace-logo {requestId}` records it. Recovery needs no live grant, only works for the requesting admin, and follows the same rules as step 4.

### 16.3 Deviations from the spec text

1. Platform admins without a workspace go to `/no-access`; the `/platform` console is P6.
2. The pre-existing legacy service-role readers (sync store, legacy session store, deployment validation) remain until P7; the SR-1 static test lists them explicitly and fails on any new reader.
3. The migration is M16 because M15 is reserved for retiring legacy tables.
4. The local Auth server did not rate-limit 40 rapid failed sign-ins, so the real-stack test asserts every answer is the generic 401 or `rate_limited` 429; the 429 mapping is proven against a fake Auth server in the unit suite.
5. Pages still read the legacy single-tenant data layer until P3/P4; P2 only decides who may reach them.

### 16.4 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (155 previous + 27 P2: provider/config, denial matrix, middleware/guards/routes in supabase mode against a dead Auth URL, misconfiguration 503, ISO-F1/F4, SR-1 allowlist, page gates, Auth status mapping + 23 review regressions, §16.5–§16.6) | Node 24.20.0 | PASS 205/205 |
| DB suite (170 previous + 17 P2 RPC tests) | PGlite + shim | PASS 187/187 |
| Concurrency suite (24 previous + 4 Storage lifecycle races, §16.6) | Real local PostgreSQL 18.6 | PASS 28/28 |
| Stack suite (17 previous + 11 app tests: AUTH-1 contracts, session refresh through the app, JSON body validation, logout replay (reads until expiry; sensitive mutation refused), signed-out behaviour, ISO-F3 forged/tampered/expired/unsigned/foreign-key cookies, ISO-F4, employee/outsider/§4.3 gates, MEM-1, SUSP-1, workspace list/switch, audited platform Storage endpoint, failed-sign-in answers) | Real Supabase local stack (disposable) + `next build`/`next start` | PASS 28/28; no app process, containers, or volumes left behind |
| `tsc --noEmit -p .` | — | PASS (except the pre-existing `NODE_ENV` assignments in `tests/auth.test.ts` and `tests/sync.test.ts`) |
| `npm run build` | Next.js 15.5.25 | PASS |

### 16.5 P2 review (Codex) — four findings, resolution and regression tests

| # | Finding | Fix | Regression tests |
| --- | --- | --- | --- |
| 1 | Client-controlled audit outcomes: an AAL2 platform admin could call `platform_storage_change_finished(..., true)` and record success without a Storage change | The outcome flag is gone. `claimed` and `finished` execute only as `service_role` (revoked from `public`, `anon`, `authenticated`); `finished` derived the outcome from `storage.objects` against a request-time snapshot (replaced in §16.6 by attribution of the server's own tagged write); only requests claimed by the server can be completed; one unfinished change per object; outcome rows carry `recorded_by: server` | PGlite: admin/member/anon get permission denied on `claimed`/`finished`, the old signature no longer exists, direct audit inserts denied, outcomes match Storage for upsert/delete/no-op, an unclaimed (spoofed) request is never completed, idempotence and requester binding, claim conflicts. Unit: completion runs with the service key and the actor from the context, never a client flag. Stack: a direct `finished` call with the admin JWT is refused, the old signature 404s, a direct `requested` call never gets an outcome, a direct `claimed` call is refused, recovery of a spoofed request 404s |
| 2 | Ignored audit-completion errors in `workspace-logo/route.ts` | Completion errors are checked and retried (3 attempts). Persistent failure → `503 audit_pending` with `requestId`; the request stays pending and blocks further changes (`409 change_pending`) until `POST /api/platform/workspace-logo {requestId}` records it (requesting admin only; no live grant needed). Failed Storage writes → `502 storage_failed` with the recorded `failed` outcome. Admin client requests time out after 30 s | Unit (local fake Supabase with fault injection): transient failure retried, persistent failure → 503 then 409 for a new change, recovery 503 while still down, then 200 and idempotent, changes allowed again afterwards; other admin 404, member 403; request failure → nothing written; delete paths. Stack: completion made to fail for real by revoking `execute` from `service_role` (restored in `finally`) → 503, no outcome, object stored, 409, recovery after restore → 200 with exactly one outcome |
| 3 | `/api/auth/me` dropped refreshed cookies from `requireApiContext` | `/api/auth/me`, `/api/workspaces`, `/api/workspaces/active`, login errors, and `requireApiContext`'s own denial and unavailable responses all apply pending cookies | Unit and stack: expired access token + valid refresh token → `/api/auth/me` 200 with the refreshed cookie set, and reusing it needs no further refresh; invalid refresh token → signed out with the cookie cleared; refreshed cookies also present on `/api/workspaces` and on 403 denials |
| 4 | Invalid JSON (`null`) crashed login | `readJsonObject` rejects invalid JSON, `null`, arrays, and primitives; fields are type-checked on every new JSON endpoint | Unit and stack: `null`, arrays, numbers, strings, and wrongly typed fields → login 400 (no Auth call), workspace switch 422 (no RPC call), recovery 422 |

Logout replay (§16.2) is a separate decision and is not changed by these fixes. Codex recommends immediate app-session revocation (a session-row check in `request_context`) before real use; it is listed as open in the checklist.

### 16.6 P2 review (Codex, third round) — audit lifecycle

Finding: recovery could finalize and release a claim while its operation might still be running, and the outcome was decided from a changed Storage snapshot, so a member's unrelated write could count as platform success.

| Requirement | Resolution | Regression tests |
| --- | --- | --- |
| Outcome reflects this specific server operation | The claim returns a secret per-operation token; the server's upsert carries it in `user_metadata`, its delete is a move to a token-named tombstone; the `storage.objects` trigger marks the claim applied only for a service-role write with the matching token, path, and operation, in the committing transaction. The snapshot (`object_before`, `workspace_asset_state`) was removed | PGlite: tagged upsert/replace/delete succeed, untagged/foreign-token/wrong-path/wrong-operation writes are not attributed or are refused; tokens are unreadable by clients and never audited. Unit: the write carries the claim's token, which never reaches the client. Stack: the real upload carries the token; the real delete leaves no logo and no tombstone |
| A member's write is never platform success | Attribution requires the pending claim's token, which only the server knows until its own write commits. The Storage API commits member and server writes identically (`service_role`, no subject, owner kept on upsert — measured with a probe on the real stack after the first run of this round attributed a test member upload that had been given the real token), so the session is not used to tell them apart. A token carried over unchanged is ignored, so a member's re-upload of a platform-written logo is never blocked | PGlite (including a carried-over token, and a finished token newly written elsewhere being refused), unit, and stack (real Storage API, including a member re-upload carrying the previous operation's token): member upsert during a pending platform upsert → `failed`; member delete during a pending platform delete → `failed` (PGlite, unit); real PostgreSQL: a concurrent member write neither blocks recovery nor counts |
| Recovery never finalizes or releases a claim while the operation may run | `finished` returns `pending` (route: `409 operation_in_progress`, `Retry-After: 120`) when the server's call did not return, the write is not applied, and the 2-minute lease is open; the claim stays (`409 change_pending` for new changes). A client-side timeout or dropped connection is reported as `operation_returned = false`, never as failure. If the claim's own response is lost, nothing is written and the route returns `503 unavailable` with the `requestId`, so a claim that was in fact recorded can be recovered | Unit (including a lost claim response): recovery while the write is held in flight → 409, nothing recorded, claim kept, then the write's own outcome is recorded; dropped response before commit → pending, after commit → succeeded. PGlite: pending keeps the claim. Stack: recovery while the server's write is outstanding → 409, new PUT 409, then the write lands and recovery records `succeeded` |
| Unknown state preserved; late writes cannot take effect | After the lease, recording `failed` closes the token under the claim row lock shared with the trigger; a write already committing is waited for (→ `succeeded`), a later one is refused (`platform_operation_closed`) and leaves the object unchanged | Real PostgreSQL (independent sessions): recovery blocks on an uncommitted in-flight write and records `succeeded` after it commits, or `failed` if it aborts; recovery first → the late write blocks, then is refused and nothing is stored. Unit, PGlite, stack (real Storage API): the fenced late write is refused and the member's object stands |

Residual, documented: if the tombstone cleanup after a successful delete fails, the old logo stays under `<ws>/.platform-trash/` inside the workspace's own folder. M16 was amended in place again (never pushed or applied outside disposable local stacks).

## 17. P3 implementation record (read parity)

Local only: nothing pushed, deployed, or applied to a hosted project; no invitations or outbound messages. With `AUTH_PROVIDER=legacy` (the default) every page and API reads the legacy sync store and tenant config exactly as before. No migrations in this phase.

### 17.1 Files

| Area | Files |
| --- | --- |
| Data layer | `src/lib/data/`: `types.ts` (`DashboardReader`, `WorkspaceView`, `DataSource`), `query.ts` (`fromWorkspace` adds `workspace_id = <active workspace>` to every query on top of RLS; `DataUnavailableError`; 500-row list cap; exact HEAD counts), `dashboard-adapters.ts` (pure native row → existing record mappers), one reader per area (`contacts`, `pipeline`, `calendars`, `conversations`, `tasks`, `reviews`, `activity`, `reports`, `workspace`), `native.ts` / `legacy.ts` (the two `DataSource`s), `index.ts` (`getPageData()`, per-request cached), `api.ts` (`readApi(req, permission, build)`), `dashboard-api.ts` (the pre-migration `/api/dashboard/*` response types and row mappers, moved unchanged from the routes) |
| Request context | `src/lib/authz/context.ts`: per-request `getPageSupabase()` shared by the context and the readers |
| APIs | `/api/dashboard/{summary,contacts,opportunities,appointments,conversations,events}` on `readApi` with `dashboard.read` / `contacts.read` / `pipeline.read` / `calendar.read` / `conversations.read` / `dashboard.read`; `/api/tenant/config` (`settings.read`; owner block only with `settings.write`); `/api/tenant/public` (platform brand only in supabase mode); `/api/health` (database check through `rpc request_context` with the anon key in supabase mode); `src/lib/auth/legacy-only.ts` for the retired endpoints |
| Pages | Dashboard, Inbox, Contacts, Opportunities, Calendars, Tasks, Reputation, Reports, Setup, Help, Resources read through `getPageData()`; Settings reads the native role and the workspace summary; markup, classes, and layout unchanged |
| Copy | `src/lib/ui/sync-copy.ts`: `dataCopy(native)` → `SYNC_COPY` (legacy strings, unchanged) or `NATIVE_COPY` (no sync, CRM, or workflow wording); `WaitingForSync` takes `native` |
| Tests | `tests/p3-data.test.ts` (unit, 23), `tests/helpers/fake-supabase.ts` (PostgREST table reads with modelled RLS, filters, ordering, `max_rows`, embeds, exact counts, fault injection), `tests/helpers/api-shapes.ts` (runtime API-1 schemas: required keys, types, no extra keys), `tests/supabase-stack/stack.test.ts` nested "the app reads each workspace's native data (P3)" (5), `tests/visual/ui2-visual-parity.ts` (UI-2 harness, not part of `npm test`) |

### 17.2 Behaviour

- **Isolation:** every native read uses the signed-in user's JWT (never the service role), filters on the active workspace from the request context (never a client-supplied id), and RLS re-checks. Soft-deleted rows are excluded explicitly, so counts and "last activity" do not vary with the reader's delete permission.
- **Shapes (API-1):** `/api/dashboard/*` return the pre-migration shapes. Metadata: `source: "workspace"`, `storageMode: "postgres"` (legacy: `"sync-store"` and the store's mode). Amounts are cents ÷ 100. Message bodies are never returned (summaries only, as before); internal notes are `direction: "unknown"`, `eventType: "conversation.internal"`. Contact email/phone stay masked.
- **Errors:** 401/403/423 per §7.1 before any data read; a failed table read → 503 `unavailable` with refreshed cookies applied; `Cache-Control: private, no-store`.
- **Pipeline value** pages through results until an empty page, so it is correct beyond PostgREST `max_rows`.
- **Retired endpoints (supabase mode):** `/api/sync/health`, `/api/onboarding/readiness`, `/api/events` (after their auth check), `/api/ghl/health`, `/api/leads` → 404 `{code:"not_available"}`. They no longer serve the single-tenant F&A store to other workspaces. `/api/webhooks/ghl` is unchanged until P7.
- **Copy:** native pages say "No contacts yet", "in this workspace", "Last activity", and so on; legacy pages keep "Waiting for sync". A workspace without calendars shows "No calendars yet" with a disabled "Create calendar (coming soon)" for `calendar.configure` holders. Setup shows a native readiness checklist (calendar, first contact, automations, payments).

### 17.3 Deviations from the spec text

1. `src/lib/tenant.ts` stays for legacy mode; the spec's `getWorkspaceConfig` is `loadWorkspaceView` in `src/lib/data/workspace.ts`.
2. Legacy-only endpoints answer 404 in supabase mode instead of being rewritten (their data has no native equivalent until P7).
3. Lists are capped at 500 rows (counts are exact); paging UI is P5.
4. A role without a page's read permission sees the empty state instead of a redirect (all current roles hold every read permission, §4).
5. Settings keeps its layout; in supabase mode the owner's Integrations card says no integrations are connected (no CRM text) and System status shows the workspace summary. The full Settings rewrite is P4.
6. Visual parity (UI-2) runs as a local harness with a cached `playwright-core` and Chromium rather than a pinned `@playwright/test` dependency; no package was added.

### 17.4 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (205 previous + 23 P3: adapters, API-1 shapes for every endpoint, exact mapped records and summary, workspace B sees only B, every read carries the user JWT and the workspace filter, paging past `max_rows`, empty workspace, 401/403/permission matrix, 503 with refreshed cookies, tenant config/public, health, retired endpoints, legacy mode unchanged with no Supabase calls, static guards) | Node 24.20.0 | PASS 228/228 |
| DB suite | PGlite + shim | PASS 187/187 (unchanged) |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 (unchanged) |
| Stack suite (28 previous + 5 P3: API-1 shapes and parity with the owner's own PostgREST view; ISO through APIs and pages; tenant config/public, health, retired endpoints; UI-1 on 19 routes with seeded data; native empty states and admin Setup/Resources gates) | Real Supabase local stack (disposable) + `next build`/`next start` | PASS 33/33 |
| UI-2 (`tests/visual/ui2-visual-parity.ts`, 1440×900 full page, empty workspace named like the baseline, per-channel tolerance 40) | Disposable stack + built app + Chromium 1243 | All 20 routes 200. Sidebar 0.00% on every page; top bar 0.00%, or 1.27% where the baseline was captured 1425 px wide (the 15 px scrollbar strip). Page differences are copy only: login, marketing, payments, privacy, terms 0.00%; support 0.91% to reporting 2.53%; settings 1.71%; dashboard 6.71%, help 9.87% (empty workspace has no support email/phone; F&A's were in the baseline); onboarding 62.70% (21 legacy CRM checks replaced by the 4-item native checklist, so the page is shorter) |
| `tsc --noEmit -p .` | — | PASS |
| `npm run build` | Next.js 15.5.25 | PASS |

### 17.5 P3 review (Codex) — two native display defects

| Defect | Fix | Regression tests |
| --- | --- | --- |
| Calendar cards matched bookings by name or the first word of the name, and an empty calendar fell back to listing every booking | `calendarAppointments` (`src/lib/ui/board.ts`): native cards list exactly the bookings whose `calendarId` is the card's id; an empty calendar shows "No appointments scheduled". Legacy matching unchanged | Unit: similar names, same name with another id, legacy fallback preserved. Stack (rendered `/calendar`): "Discovery Call" with a booking, "Discovery Follow-up" without, "Site Visit" with its own — each card lists only its own bookings and the empty one shows its empty state |
| Pipeline columns grouped opportunities by stage-name substring, so overlapping or duplicate names put one opportunity in several columns | The workspace view keeps stage ids (`WorkspaceView.stages`); `pipelineColumns` places each opportunity in the column with its `stageId`; column counts and values are exact database totals per stage id (`stageTotals`, paged past `max_rows`, deleted rows excluded, other pipelines excluded), summed in cents. Legacy matching unchanged | Unit: duplicate "Qualified" stages, "New Lead" / "New Lead Follow-up", a rename keeps the id, totals exact and paged, no opportunity placed twice, legacy behaviour pinned. Stack (rendered `/pipeline`): renamed stages with duplicate and overlapping names → items per column `[0,0,1,0,0,0,0,2,0,1,0,0]`, values `$200.5`, `$400.01`, `$999.99`, summary cards and banner count each opportunity once; renaming again keeps the column and the API reports the new name |

Results: unit 235/235, PGlite 187/187, real PostgreSQL 28/28, stack 36/36, `tsc` and `npm run build` PASS.

## 18. P4 implementation record (team and settings)

Local only: nothing pushed, deployed, or applied to a hosted project. No invitation email or SMS is ever sent: invite links are shown once to the inviter. With `AUTH_PROVIDER=legacy` (the default) every P4 endpoint answers 404 and Settings/Onboarding render exactly as before.

### 18.1 Files

| Area | Files |
| --- | --- |
| Migration | `supabase/migrations/20261101001600_team_settings.sql` (M17, additive): `list_team_members()` (team.read; active members with sign-in email and overrides), `set_member_permissions(user, overrides)` (several overrides atomically, each through `set_member_permission`), `invitation_signup_email(token)` (service role only, behind A1), `private.record_config_change()` triggers on `workspace_settings`, `ai_receptionist_configs`, `integrations` (changed field names only, never values; actor from `auth.uid()`). Rollback block in `supabase/rollback/20261101_native_multi_tenant.down.sql` |
| API helpers | `src/lib/api/native.ts`: `nativeApi` (supabase mode only, session + active workspace + permission, the caller's JWT, refreshed cookies, `private, no-store`), `ApiError`/`dbFailure` (M11 codes and SQLSTATEs → §7.1), strict `parseBody`/`parseQuery` (workspace keys dropped per ISO-F1, other unknown keys 422), `parseId`, opaque keyset cursors, `appOrigin` (invite link origin: server-only `APP_ORIGIN` if set, else the request Host) |
| Domain modules | `src/lib/native/`: `team.ts`, `invitations.ts`, `settings.ts` (workspace profile + AI receptionist), `integrations.ts`, `audit.ts`, `onboarding.ts`, `shared.ts` |
| Routes | `/api/team`, `/api/team/[userId]`, `/api/team/invitations`, `/api/team/invitations/[id]`, `/api/invitations/[token]`, `/api/invitations/[token]/accept`, `/api/settings/workspace`, `/api/settings/ai-receptionist`, `/api/integrations`, `/api/audit`, `/api/onboarding/checklist` |
| Admin Auth | `src/lib/supabase/admin.ts`: `createUserFromInvitation` (allowlist entry A1); `src/lib/supabase/server.ts`: `supabaseAnonymous()` for the public preview |
| Pages | `src/app/invite/[token]/` (landing: preview, create account or sign in, accept); `src/components/settings/NativeSettings.tsx` (Business Profile, Integrations, Team / Staff with invite link, role select, remove dialog, invitations list with revoke, AI Receptionist, Recent changes) rendered by the existing Settings page in supabase mode; Onboarding shows the native checklist. Existing `Card`, `Badge`, `Modal`, `EmptyState` components and classes; no layout change |
| Middleware | P4 and P5 API prefixes added to the protected list (no behaviour change otherwise) |
| Tests | `tests/p4-team-settings.test.ts` (unit), `tests/db/p4-team-rpcs.test.ts` (PGlite), stack describe "team, invitations, and settings through the app (P4)" (8 API tests + 1 browser test) and the final NET-1 test; `tests/helpers/net-guard.cjs` |

### 18.2 Behaviour

- **Authority stays in the database.** Every team, invitation, override, and settings change runs with the caller's JWT through the existing M11 RPCs (`set_member_role`, `set_member_permission(s)`, `remove_member`, `create_invitation`, `revoke_invitation`, `accept_invitation`) or column-granted tables under RLS. Role authority (§4.2), self-change rules, last-owner protection, and the post-lock re-check apply unchanged; the app adds input validation and §7.1 error mapping only.
- **Invitations:** `POST /api/team/invitations` returns `inviteUrl` once (the raw token is never stored; only its hash). Nothing is sent. Lists show email, role, expiry, and status, never the token. Revocation is immediate. The landing page `/invite/[token]` calls the public preview (`workspaceName`, `role`, masked email, `accountExists`) and either signs in (the signed-in email must match) or creates the account for the invitation's own address (A1: the email comes from the database, never the client), then accepts with the new user's own JWT. Expired/used/revoked → 410, unknown → 404, mismatch → 403, existing account → 409 `account_exists`.
- **Settings:** profile fields validated strictly (timezone from the IANA list, http(s) URLs only, hex colours, `HH:MM` business hours with start before end, phone characters, email lowercased). `logoPath` is not client-writable (Storage endpoint only). Changes are stamped by the database and recorded as field names in the audit log.
- **AI receptionist:** greeting, hours mode, escalation member (must be an active member of this workspace). `enabled` cannot be set by any client (constraint and validation); the response always reports `enabled: false, runtimeAvailable: false`.
- **Integrations:** read-only list of provider, status, capabilities, and verification time. Config values are never returned; status and verification are server-controlled (no client grant).
- **Onboarding checklist:** computed from records: profile (support email or business phone), team (more than one active member), calendar (an active calendar), AI config (a greeting). Requires `onboarding.read` (owner).
- **Outbound:** the stack suite runs `next start` with `tests/helpers/net-guard.cjs`, which refuses and logs any non-loopback connection; the final test asserts the log is empty and that the disposable stack config has no SMTP or SMS route.

### 18.3 Test IDs defined by this phase

| ID | Test |
| --- | --- |
| SET-1 | Members with `settings.read` read the active workspace's profile; it never includes another workspace's data. |
| SET-2 | Only `settings.write` (owner/admin) changes the profile; employees get 403. |
| SET-3 | A client-supplied workspace id is ignored; only the active workspace changes. Malformed fields (empty name, unknown timezone, `javascript:` URL, bad email/colour/hours/phone, `logoPath`) → 422. |
| SET-4 | Changes are stamped by the database (`updated_by`) and audited with the changed field names, never their values. |
| SET-5 | AI receptionist settings save, but nothing can enable it (API 422 and direct PostgREST refused); escalation must be an active member of this workspace; unknown fields 422. |
| SET-6 | `/api/integrations` never returns config secrets; clients cannot change integration status. |
| SET-7 | The onboarding checklist reflects real records and requires `onboarding.read`. |

### 18.4 Deviations and limitations

1. A1 uses a service-role-only RPC (`invitation_signup_email`) to read the invitation's email before `auth.admin.createUser`; the client never supplies the email. The account is created confirmed (no confirmation email exists locally).
2. If acceptance fails after A1 created the account (a race with revocation or expiry), the account remains without membership; the person can sign in and sees `/no-access`. No cleanup runs automatically.
3. Overrides are API-only (`PATCH /api/team/[userId] { overrides }`); Settings has no overrides editor yet.
4. Password policy on the invite page: 12–72 characters plus GoTrue's own checks.
5. Business hours are shown but not editable in the Settings card (API supports them).
6. Next normalises a `127.0.0.1` host to `localhost` in `req.nextUrl` and in middleware redirects (`NextURL`). Invite links therefore use `appOrigin` (server-only `APP_ORIGIN` when set, else the forwarded/Host header), so a link matches the address the inviter used. Redirects are unchanged; local browser tests use `localhost` so host-only cookies survive them. Deployed environments should set `APP_ORIGIN`.

### 18.5 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (235 previous + 22 P4: schemas, error mapping, legacy 404, invite link origin, NET-1 guard in a child process, static guards; P2/P3 tests updated for the new routes) | Node 24.20.0 | PASS 257/257 |
| DB suite (187 previous + 10 P4: `list_team_members`, atomic overrides with rollback, A1 lookup is service-role only and never for an existing account, configuration attribution without values) | PGlite + shim | PASS 197/197 |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 (unchanged) |
| Stack suite (36 previous + 9 P4 + NET-1: INV-1/2/3/4/6/7, preview and A1 account creation, ROLE-1..8, MEM-1/2/4, SUSP, SET-1..7, browser flow, no outbound connection and no SMTP/SMS route) | Real Supabase local stack (disposable) + `next build`/`next start` + Chromium 1243 | PASS 46/46 |
| Browser flow (owner signs in, creates an invite link shown once, invitee creates an account from the link, password mismatch shown, employee view is read-only, role change, removal → `/no-access`, profile and AI settings saved, revoked link → "Invitation unavailable") | same | PASS (screenshots in a temp directory) |
| `tsc --noEmit -p .` | — | PASS |
| `npm run build` | Next.js 15.5.25 | PASS |

The stack suite could not observe a mail catcher (the local config disables `local_smtp`); NET-1 instead asserts that the disposable config has no SMTP or SMS route and that the app opened no non-loopback connection.

## 19. P5 implementation record (native records)

Local only: nothing pushed, deployed, or applied to a hosted project. Nothing is sent externally: the inbox stores internal notes only, and no route, RPC, or grant lets a client create an outbound message or change delivery status. With `AUTH_PROVIDER=legacy` (the default) every P5 endpoint answers 404 and Contacts, Opportunities, Calendars, Tasks, and Conversations render exactly as before (the original inbox client is kept verbatim as `InboxClient.tsx`).

### 19.1 Files

| Area | Files |
| --- | --- |
| Migration | `supabase/migrations/20261101001700_native_crm.sql` (M18, additive): `save_contact(id, values, tags)`, `save_calendar(id, values, member_ids)`, `replace_availability(calendar, rules)` — security invoker, so RLS, column grants, and integrity triggers apply exactly as for direct PostgREST writes, each in one transaction; `private.record_crm_activity()` triggers on contacts, contact notes, opportunities, calendars, appointments, tasks, and messages (actor from `auth.uid()`, changed field names only; nothing recorded for writes without a JWT subject). Rollback block in `supabase/rollback/20261101_native_multi_tenant.down.sql` |
| Domain modules | `src/lib/native/`: `contacts.ts`, `opportunities.ts`, `calendars.ts`, `tasks.ts`, `conversations.ts`, `reviews.ts`, `reports.ts`, `records.ts` (keyset paging, exact counts, search words) |
| Routes | `/api/contacts`, `/api/contacts/[id]`, `/api/contacts/[id]/notes`, `/api/pipeline`, `/api/pipeline/stages/[id]`, `/api/opportunities`, `/api/opportunities/[id]` (GET/PATCH/DELETE), `/api/opportunities/[id]/move`, `/api/calendars`, `/api/calendars/[id]`, `/api/calendars/[id]/availability`, `/api/appointments`, `/api/appointments/[id]`, `/api/tasks`, `/api/tasks/[id]`, `/api/conversations`, `/api/conversations/[id]/messages`, `/api/conversations/[id]/notes`, `/api/reviews`, `/api/reports/summary` |
| UI | `src/components/records/`: `NativeContacts.tsx`, `NativeBoard.tsx` (add/edit/move/delete opportunity), `NativeCalendar.tsx` (calendar editor with members and weekly availability, booking, appointment edit), `NativeTasks.tsx`, `NativeInbox.tsx`, `pickers.tsx`; `src/lib/ui/native-api.ts`. Pages under `src/app/(protected)/` choose native components only in supabase mode, using the existing `PageHead`, `Card`, `DataTable`, `Modal`, `Button`, and form classes |

### 19.2 Behaviour

- **Authority stays in the database.** Every read and write runs with the caller's JWT under RLS and column grants; the app checks the same permission first (`nativeApi`) and adds strict validation and §7.1 error mapping. Client-supplied workspace ids are dropped (ISO-F1); every referenced id (contact, stage, calendar, member, assignee, owner) must belong to the active workspace and, for people, be an active member — otherwise 422. Ids from another workspace answer 404.
- **Contacts:** create/edit (name, email, phone, source, owner, tags, do-not-disturb) atomically with tags; detail with related counts; notes stamped with the author; soft delete (`contacts.delete`, owner/admin) through `soft_delete_contact` with an audit entry. List: multi-word search across name/email/phone, tag filter, newest first, keyset cursor, exact total.
- **Opportunities:** create/edit with integer cents; moves are by stage id only (`/move`); the stage decides status (closing stages set won/lost and `closed_at`, reopening clears it). Delete and stage rename need owner/admin permissions.
- **Calendars:** create/edit (`calendar.configure`) with an exact member set and weekly availability replaced atomically (overlapping windows 422). Appointments: create/reschedule/status changes; the database exclusion constraint refuses overlapping active bookings on one calendar (409 `overlap`, also under concurrency); cancelled bookings free the slot; inactive calendars refuse bookings.
- **Tasks:** create/edit, assignment to active members only, status changes (open/done/cancelled), due dates with timezone offsets, exact open/completed/stale counts.
- **Inbox:** conversation list (status filter, keyset) and message pages (newest first, keyset); `POST /api/conversations/[id]/notes` inserts `direction = internal`, `delivery_status = not_sent` with the author. No send path exists.
- **Display:** money from integer cents; timestamps shown in UTC (`YYYY-MM-DD HH:MM`) so server and client render identically; booking forms take the browser's local time and say so. Empty states and error notices use the existing copy and components.

### 19.3 Test IDs defined by this phase

| ID | Test |
| --- | --- |
| CRUD-1 | Contacts: create, edit, notes, detail, search, tag filter, keyset pages with exact totals, duplicate email 409, malformed 422, foreign owner 422, employee delete 403 (app and RPC), owner soft delete with audit, foreign ids 404. |
| CRUD-2 | Opportunities: exact cents; stage ids decide column and status; cross-workspace contact/stage/member 422; `stageId` in PATCH 422; employee delete/rename 403; reports and board show exact values. |
| CRUD-3 | Calendars and appointments: member assignment (outsider/foreign 422), availability validation, overlap on create and reschedule, concurrent overlapping bookings (one 200, one 409), cancel frees the slot, inactive calendar refused, UTC display. |
| CRUD-4 | Tasks: assignment, status changes, removed and foreign assignees 422, exact counts with paging, read-only overrides enforced by the app and by PostgREST. |
| CRUD-5 | Inbox: conversation and message paging, internal notes stored as `internal`/`not_sent`, outbound inserts and delivery-status writes refused, foreign threads 404, no outbound connection. |

### 19.4 Deviations and limitations

1. The pipeline board still shows at most 8 opportunities per column (and the existing 500-row list cap); opportunities beyond that are reachable through the API but not editable from the board.
2. Appointments and tasks have no delete route; appointments are cancelled by status, tasks are completed or edited.
3. Booking and task forms take local time; lists display UTC.
4. Conversations are not created by the app; they will come from channel ingestion in a later phase. The inbox reads them and accepts internal notes only.
5. Permission overrides remain API-only (no editor in Settings), as in P4.

### 19.5 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (257 previous + 21 P5: strict schemas for every P5 body and query, keyset cursors and tampering, 401 without a session on 29 handlers, employee 403 on delete/configure routes with no RPC call, read-only 403 on all 17 writes, 14 malformed inputs → 422, client workspace ids dropped, legacy 404, static guards: permission per handler, no service role, nothing outbound, internal-only message insert) | Node 24.20.0 | PASS 278/278 |
| DB suite (197 previous + 12 P5: `save_contact`, `save_calendar`, `replace_availability` validation, cross-workspace and outsider refusal, override denial, activity events with actor and field names only, no events for server writes, clients cannot write activity directly) | PGlite + shim | PASS 209/209 |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 (unchanged) |
| Stack suite (46 previous + 7 P5: CRUD-1..5, workspace switching, browser flow) | Real Supabase local stack (disposable) + `next build`/`next start` + Chromium 1243 | PASS 53/53 |
| Browser flow (contact add with an invalid phone refused first, search, detail, note; opportunity $1,234.56 edited to Won; calendar created and booked at 10:00 New York time shown as 14:00 UTC, overlapping booking refused with a message; task added and completed; inbox internal note stored as `internal`/`not_sent`) | same, browser timezone America/New_York | PASS (screenshots in a temp directory) |
| UI-2 visual harness | disposable stack + built app + Chromium | Sidebar 0.00% on all 20 pages; P5 pages 1.2–2.2% overall (native copy, filters, and action buttons); Settings and Onboarding differ by their P4 native content |
| `tsc --noEmit -p .` | — | PASS |
| `npm run build` | Next.js 15.5.25 | PASS |

The first stack run of the workspace-switching test failed because the test created its "home" contact after accepting the invitation, and acceptance activates the invited workspace (M11). The test now creates the contact first, asserts its workspace in the database, asserts that acceptance switches the active workspace, and checks every listed id against the database instead of matching text. No application change was needed.

## 20. P6 implementation record (platform console)

Local only: nothing pushed, deployed, or applied to a hosted project; no invitation is sent (links are shown once to the admin who created them). With `AUTH_PROVIDER=legacy` (the default) every `/platform` page and `/api/platform/*` and `/api/auth/mfa/*` endpoint answers 404.

### 20.1 Files

| Area | Files |
| --- | --- |
| Migration | `supabase/migrations/20261101001800_platform_console.sql` (M19, additive): `platform_status()` (caller's own `{listed, aal, active}`), `platform_search_workspaces` (name/slug/owner-email search with literal `%`/`_`, status filter, keyset on `(created_at, id)`, exact total), `platform_get_workspace` (detail with member counts and the open owner invitation's id and dates only), `platform_list_grants`, `platform_audit_page` (keyset on id, actor email, optional workspace), and `platform_revoke_access(grant, reason)` (reason 10–500 characters, written to both audit logs). The one-argument `platform_revoke_access(uuid)` is no longer executable by `authenticated`. Rollback block restores it |
| Server | `src/lib/api/platform.ts` (`platformApi`: supabase mode, session, platform authority from the database, `mfa_required` for listed AAL1 admins, Auth-server session re-check on sensitive actions), `src/lib/platform/console.ts` (strict schemas and RPC calls), `src/lib/platform/page.ts` (page guards), `src/lib/auth/mfa.ts` (TOTP enrol/verify through the user's own Supabase session) |
| Routes | `GET/POST /api/platform/workspaces`, `GET /api/platform/workspaces/[id]`, `POST …/[id]/suspend`, `…/[id]/reactivate`, `…/[id]/access`, `…/[id]/bootstrap-invitation`, `GET …/[id]/audit`, `GET /api/platform/audit`, `GET /api/platform/access`, `DELETE /api/platform/access/[grantId]`; `GET /api/auth/mfa`, `POST /api/auth/mfa/enroll`, `POST /api/auth/mfa/verify` |
| UI | `src/app/(platform)/platform/` (workspaces, workspace detail, audit, MFA) with `src/components/platform/` (`PlatformShell` — the existing top bar, content, and footer without the client sidebar — `PlatformWorkspaces`, `PlatformWorkspaceDetail`, `PlatformAudit`, `MfaSetup`, `shared`); `src/components/SupportAccess.tsx` (banner on every workspace page during a grant); `/no-access` sends AAL2 admins to `/platform` and offers listed AAL1 admins the MFA step |
| Middleware | `/platform` pages are decided before rendering: AAL2 admins pass, listed AAL1 admins are redirected to `/platform/mfa`, everyone else gets the ordinary 404 page; an unknown status is 503, never access |

### 20.2 Behaviour

- **Platform authority is separate from membership.** It comes only from a `platform_admins` row plus an AAL2 session (`private.is_platform_admin()`); no workspace role is involved, and a workspace member who is not listed is refused everywhere (403). A listed admin with a password-only session gets 403 `mfa_required` from every console API and is sent to `/platform/mfa` by every console page.
- **MFA.** If the app's session is AAL1, `/platform/mfa` enrols a TOTP authenticator through GoTrue (QR code and setup key shown once to that user; abandoned enrolments are removed first; a second verified authenticator is refused with 409) and verifies the current code, which upgrades the same cookie session to AAL2. Wrong or malformed codes are 422, throttling 429. A new sign-in is AAL1 again and needs a code.
- **Provisioning** runs `platform_provision_workspace` (one transaction: workspace, settings, AI receptionist config, default pipeline with 12 stages, bootstrap owner invitation, audit). It is idempotent per provisioning key: a repeat with the same inputs returns the same workspace and no link; different inputs or a taken slug are 409; concurrent identical requests create exactly one. The owner link is returned once and never stored or shown again.
- **Bootstrap invitation rotation** needs a reason, revokes every open owner invitation, and returns one new link; it is refused (409) once an owner has joined.
- **Suspension/reactivation** need a reason. While suspended, members get 423; read grants still read; write grants confer nothing (403 `no_active_workspace`, by design of `active_grant_id`), and new write grants are refused with 423.
- **Support access** (`read`/`write`, 1–480 minutes, reason required) switches the admin's active workspace to the target. Every workspace page shows a banner with the workspace, the mode, the expiry in UTC, and minutes left, with links back to the console and to end access (reason required). Revocation and expiry apply on the next request. Writes under a write grant are attributed to the admin and the grant in `workspace_audit_log`. Ids from other workspaces answer 404.
- **Audit view.** Platform audit entries (all workspaces or one) with actor email, reason, and metadata; keys that look like credentials (`token`, `hash`, `secret`, `password`) are dropped before they reach the browser. No response carries an invitation token or hash except the one-time link at creation/rotation.
- **Target workspace in the path.** Console routes take the workspace from `/api/platform/workspaces/[id]/…`; body or query workspace ids are dropped (ISO-F1 applies unchanged to tenant routes).

### 20.3 Test IDs defined by this phase

These console tests (CON) run through the app and also exercise the §10 criteria PLAT-1 (CON-6, CON-7), PLAT-2 (CON-6), PLAT-3 (CON-1, CON-2), SUSP-1/SUSP-2 (CON-8), SUSP-5 (CON-8), and SUSP-6 (CON-8).

| ID | Test |
| --- | --- |
| CON-1 | Denial: signed out 401; workspace members 403 on every console API and MFA endpoint, 404 on every console page; listed AAL1 admin 403 `mfa_required` and redirected to MFA; nothing recorded. |
| CON-2 | MFA through the app: enrolment replaces abandoned factors, wrong/short codes and bad factor ids 422, AAL2 cookies issued, second authenticator 409, re-login needs a code, setup key never shown again. |
| CON-3 | Provisioning: malformed 422, four concurrent identical requests → one workspace, one link; repeat → no link; conflicting inputs and taken slug 409; 12 stages; audit attributed; detail without tokens. |
| CON-4 | Rotation: reason required, old link 410 `invitation_revoked`, new owner joins through the link (A1), rotation then 409, audit with reason and no token. |
| CON-5 | Search and paging: keyset pages without overlap, exact total, owner-email search, literal `%`, status filter, malformed queries 422. |
| CON-6 | Grants: read grant reads and cannot write; banner shows workspace, mode, expiry; other workspaces 404; ending needs a reason and applies on the next request; double end 404; write grant attributed in `workspace_audit_log`; both audit logs carry the reasons. |
| CON-7 | A one-minute grant expires by the clock on the next request (expired, not revoked). |
| CON-8 | Suspension from the console: members 423; existing write grant no access; new write grant 423; read grant reads with the banner marked suspended; reactivation restores records; audit attributed. |
| CON-9 | A logged-out AAL2 cookie is refused for sensitive actions and nothing is recorded; browser flow (no-access → MFA enrolment in the UI with a wrong code first → provision with the link shown once → search → detail → read access → banner → end access → audit). |

### 20.4 Deviations and limitations

1. The §7.5 `GET /api/platform/audit?workspaceId=` filter is served by `GET /api/platform/workspaces/[id]/audit`, and grants per workspace by `GET /api/platform/workspaces/[id]`, because `parseQuery`/`parseBody` drop client workspace ids everywhere. `GET /api/platform/audit` lists all workspaces.
2. `DELETE /api/platform/access/[grantId]` takes a JSON body `{ reason }`; the end-access reason is now mandatory (the one-argument RPC is no longer callable by clients).
3. Provisioning has no reason field (the §5.3 contract has none); the action is audited with its slug and owner email.
4. MFA recovery when an admin loses the authenticator device is not self-service: another platform admin or the operator must remove the factor (documented gap; no recovery codes).
5. A write grant on a suspended workspace answers 403 `no_active_workspace` rather than 423, because the database treats it as no access at all.
### 20.5 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (278 previous + 20 P6: strict schemas, MFA failure mapping, credential-free audit metadata, 401 on all 11 console and 3 MFA handlers, members 403 everywhere with no MFA call, listed AAL1 admins `mfa_required` with no RPC beyond the status check, missing/short reasons and malformed input 422 before any write, workspace ids in bodies dropped, one-time owner link, error mapping 409/404/423/403/503, middleware page gate 404/307/200/503, legacy 404, static guards) | Node 24.20.0 | PASS 298/298 |
| DB suite (209 previous + 8 P6: status, refusal of every console RPC for members/outsiders/AAL1/anon, literal search with paging and exact totals, malformed filters, detail without tokens, grants and reasoned revocation in both audit logs, expired grants cannot be ended, audit paging) | PGlite + shim | PASS 217/217 |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 (unchanged) |
| Stack suite (53 previous + 10 P6: CON-1..9 and the browser flow) | Real Supabase local stack (disposable) + `next build`/`next start` + Chromium | PASS 63/63 |
| Browser flow (password sign-in lands on `/no-access` with the MFA link; enrolment in the UI with a wrong code refused first; provisioning shows the owner link once; search; detail; read access opens the dashboard with the banner "P6 Alpha (synthetic) · Read-only · expires … UTC (15 min left)"; ending access returns to the console; audit page shows the reason) | same | PASS (screenshots in a temp directory) |
| UI-2 visual harness | disposable stack + built app + Chromium | Unchanged from P5: sidebar 0.00% on all 20 pages; differences are native copy and P4 Settings/Onboarding content |
| `npm run typecheck` (app, then test files via `tsconfig.tests.json`) | — | PASS |
| `npm run build` | Next.js 15.5.25 | PASS |
| Secret scan of every changed and new file; browser bundles | — | No secrets. One existing synthetic placeholder in `tests/auth.test.ts` (not changed by P6); the login bundle names `AUTH_SECRET` in an existing legacy message, with no value |
| Disposable stack cleanup | Docker | 0 containers, volumes, networks, or temp projects left |

Fixes made during the P6 runs: (1) the first stack run failed in the provisioning test because the test expected an unknown key's error under its own name; the API reports unknown keys under `body`, and the test now expects that (later P6 tests failed only because that workspace was never created); (2) the suspension test expected 423 for an existing write grant, but the database treats a write grant on a suspended workspace as no access (403 `no_active_workspace`); the expectation was corrected and the test now also asserts nothing was written; (3) the audit showed "Support access ended" for a grant that had already expired (test cleanup ended it), so `platform_revoke_access` now ends live grants only, with PGlite and stack tests; (4) test files were not type-clean (Next's global `ProcessEnv` type and handler casts); they are now checked by `npm run typecheck` with no change to any assertion.

## 21. P7 implementation record (GHL runtime retired)

Local only: nothing pushed or deployed; no hosted project touched. M15 not executed; no legacy table dropped or altered; no real/private configuration removed; legacy authentication (T6) not retired. `AUTH_PROVIDER=legacy` remains the default.

### 21.1 Files

| Area | Change |
| --- | --- |
| Deleted (§8.3, recoverable from Git) | `src/lib/{ghl,mapping,owner-values,master-guard,leads,env,tenant,tenant-ui}.ts`, `src/lib/auth/legacy-only.ts`, `src/lib/sync/*` (except the two files moved below), `src/lib/onboarding/*`, `src/lib/deployment/*`; routes `/api/ghl/health`, `/api/webhooks/ghl`, `/api/leads`, `/api/sync/health`, `/api/events`, `/api/onboarding/readiness`; `public/ghl-custom.css`; `scripts/{check-client-readiness,client-prepare,generate-client-deployment,validate-client-env}.ts`; `config/` (synthetic client JSON only); npm scripts `check:readiness`, `client:*` |
| Archived (`git mv` → `docs/archive/`, index in `docs/archive/README.md`) | the three GHL contract docs of §8.3 plus the per-client runbook, clone manifest, go-live gate, onboarding checklists, first fake-client E2E, tenant content audit, `$297`/`297` feature matrices, and `checklists/{SNAPSHOT_CLONE_SYSTEM,POST_CLONE_VALIDATOR,WEBSITE_GHL_INTEGRATION}.md` |
| New | `src/lib/data/records.ts` (record and summary types formerly in `sync/types.ts`); `src/lib/legacy/snapshot.ts` (read-only snapshot store: memory or the existing `sync_*` tables, every query filtered by the legacy partition); `src/lib/legacy/deployment.ts` (the F&A identity the pre-P7 build showed by default: business, 12 stages, 5 calendars, branding); `src/lib/legacy/rest-client.ts` (from `sync/db-client.ts`, now GET/HEAD only); `src/lib/legacy/rest-auth.ts` (moved unchanged); tests `legacy-snapshot.test.ts`, `p7-retirement.test.ts`, helper `tests/helpers/forbidden-terms.ts` |
| Modified | `src/lib/data/{index,api,legacy}.ts` (legacy modules loaded by dynamic import inside the legacy branch only); `api/health`, `api/tenant/config`, `api/tenant/public`; Settings, Onboarding, Library, Dashboard, Help pages; `middleware.ts` (retired paths removed from public/protected lists and matcher); `brand.ts` (D7 phone 781-964-0654); `.env.example` (no `GHL_*`, `FAKE_CONTACT_ONLY`, `ALLOW_PRODUCTION_CONTACT_WRITES`, `FORBIDDEN_MASTER_LOCATION_ID`, `CLIENT_CONFIG_PATH`); `scripts/verify-auth-runtime.mjs` (GHL probes removed); README; `docs/VERCEL_RELEASE_POLICY.md` |

### 21.2 Behaviour

- **Native mode** (`AUTH_PROVIDER=supabase`) has no GHL code on any path: no import, environment read, or route. The retired routes answer 404 (Next's not-found, not the P3 `not_available` body).
- **Legacy mode** keeps the original login and pages. Its data is the frozen `sync_*` snapshot (last activity received before sync was retired), read-only; with no Supabase configured it shows empty states as before. Settings → Integrations shows "Not connected" with "Workflow sync is no longer active for this dashboard." Onboarding shows the static setup steps (no readiness probe). Business identity, stages, calendars, colours, and empty booking/review URLs equal the pre-P7 defaults.
- **Legacy health** (`/api/health`): `{ ok, service, product, authProvider: "legacy" }`, plus `up`/`ts` anonymously, and `brand`, `intendedHost`, `storageMode` for privileged callers. No GHL probe, location, or dry-run fields.
- **Legacy tenant config** owner block is `{ pipelineName, stagesCount }` (was `locationConfigured`).

### 21.3 Remaining GHL dependency (exact, test-enforced)

Full removal conflicts with the retained legacy mode until T6/M15. `tests/p7-retirement.test.ts` pins the remaining matches exactly, so any new reference or the removal of the last ones fails the suite:

1. GHL-1 (`ghl|highlevel|leadconnector|location_id`, case-insensitive, over `src/`, `scripts/`, `public/`, `supabase/migrations/2026110*`): only `src/lib/legacy/deployment.ts` and `src/lib/legacy/snapshot.ts`.
2. GHL-2 (code reading `GHL_*` or the retired settings): only `src/lib/legacy/deployment.ts` reads `GHL_LOCATION_ID` — the legacy snapshot partition (trimmed; default `kIXDnRuhkj6HLR1g6V6V`; the Master `NQwD3zdWCuBSVpOuzybj` is refused). Native mode never loads this module.
3. Outside GHL-1 scope: the legacy migration `20260917121316_sync_store.sql` (creates the `sync_*` tables; kept because the tables are kept until M15), and the legacy session store/edge (`session-store.ts`, `session-edge.ts`, T6) using `legacy/rest-auth` and `legacy/rest-client`.

These go at T6 (legacy auth retired) and M15 (legacy tables dropped), both gated on George's approval (§11).

### 21.4 Deviations and limitations

1. Legacy data is frozen: P7 removes webhook ingestion, so a legacy deployment from this build no longer receives new activity. **Deploy ordering:** a P7 build must not serve production while live workflow webhooks are still expected; until native cutover the production target stays the pre-P7 build (`release` @ `9c189f8`).
2. `CLIENT_CONFIG_PATH` and `GHL_PIPELINE_ID` are no longer read; the legacy identity is the F&A default only. A legacy deployment that set either variable would show F&A defaults; check the production environment for them before promoting any P7 build (staging/cutover checklist).
3. `/api/events` is removed rather than kept for legacy owners; the dashboard activity feed (`/api/dashboard/*`) covers it.
4. Latent bug fixed: the legacy task listing read a non-existent column `assigned_user`; it reads `assigned_user_id`.
5. Unit test count: 298 → 240. 78 tests of deleted code (sync ingestion, webhook signature/Master guards on ingestion, onboarding readiness, deployment and client-config validation, `$297` checks) were removed with that code; 20 were added (12 legacy snapshot, 8 retirement guards). No remaining test was weakened; the runner minimum is 240.
6. Rollback: `git revert` of the P7 commit, or deploy the pre-P7 build (§11). No data or schema changed.
7. Defect found and fixed during the P7 runs: after the GHL card was removed, Settings still fetched `/api/health` but no longer read the body, and in Chromium that request never completed, so the page never reached network idle (UI-2 timed out on `/settings`; the page itself rendered). Settings no longer fetches `/api/health` (it carried no information the page uses; session expiry is still detected through `/api/tenant/config`); a static assertion in `tests/p3-data.test.ts` guards it. The UI-2 harness now names the pending requests when a page does not settle.

### 21.5 Results (2026-11-01, this machine)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (298 at `619a558` − 78 deleted with retired code + 20 new) | Node 24.20.0 | PASS 240/240 |
| DB suite | PGlite + shim | PASS 217/217 (unchanged) |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 (unchanged) |
| Stack suite (retired routes 404 incl. webhook POST; employee owner-API check moved from `/api/events` to `/api/audit`; NET-1 empty) | Real Supabase local stack (disposable) + `next build`/`next start` + Chromium; app started with every `GHL_*`, `AUTH_*`, `SUPABASE_*`, `VERCEL*` variable removed and native values injected | PASS 63/63, twice (before and after the Settings fix; the second run is on the committed source) |
| Legacy runtime smoke (`next start`, default `AUTH_PROVIDER`, no `GHL_*`/`AUTH_*`/`SUPABASE_*` variables) | built app, local only | `/api/health` 200 `{ok, authProvider:"legacy", storageMode:"memory", …}` with no CRM fields; `/login`, `/dashboard` 200 (local open mode, pre-existing); `/api/ghl/health`, `POST /api/webhooks/ghl`, `POST /api/leads`, `/api/sync/health`, `/api/events`, `/api/onboarding/readiness`, `/ghl-custom.css` 404 |
| GHL variables at build time | — | none in the shell, no `.env.local`; `.env.example` has none |
| UI-2 visual harness | disposable stack + built app + Chromium | All 20 routes 200; sidebar 0.00% on every page; top bar 0.00% or 1.27% (baseline scrollbar strip); other pages equal to P3–P5 figures (help 9.87%, dashboard 6.71%); Settings 56.98% and Onboarding 62.71% are the P4 native content (page length changed). First two runs failed on `/settings` (defect 7 above) |
| `npm run typecheck` | — | PASS |
| `npm run build` | Next.js 15.5.25 | PASS; no retired route in the route list |
| Secret scan of every changed and new file | — | no secrets; matches are the existing synthetic test placeholders in `tests/auth.test.ts` and `tests/supabase-rest-auth.test.ts`, unchanged by P7 |
| Disposable stack cleanup | Docker | 0 containers, volumes, networks, or temp projects left |

Unit, DB, and concurrency results above are from the final source (rerun after the Settings fix).
| Browser bundle scan (`.next/static`, 112 files) | — | 0 files contain `ghl`/`highlevel`/`leadconnector`, either partition id, `GHL_`, service-role names, `sb_secret_`, JWTs, or private keys; one names `AUTH_SECRET` in the existing legacy login message (no value) |

## 22. Local acceptance rehearsal (P1–P7)

Local only: fresh disposable Supabase stacks, synthetic businesses ("Harbor Plumbing (synthetic)", "Summit Roofing (synthetic)"), `example.invalid`-style addresses. No staging or production project was accessed. Suite: `tests/acceptance/acceptance.test.ts` (`npm run test:acceptance`, minimum 16), one stack per run, torn down afterwards. Setup inserts the platform-admin row directly (as every suite does; see 22.3).

### 22.1 Journeys exercised (16 tests, in order, one shared world)

MFA to AAL2; provisioning (idempotent, link once); invitation acceptance (new and existing account); team roles and settings; contacts, opportunities, calendars/appointments, tasks, and internal notes across owner/admin/employee with activity attribution and the original sidebar; permission override grant/deny audited to the acting admin; workspace switching by a member of both businesses; malformed requests (7 body kinds on every owner and platform mutating route, junk ids and queries; record counts unchanged; unknown API and page 404); concurrency (5 duplicate invitations → one 200 and four 409; simultaneous stage moves consistent); keyset pagination; support grants (read banner, read cannot write, ending needs a reason, write attributed to the grant, clock expiry); suspension and reactivation; access removal (open work unassigned, audited); logout replay measurement; legacy mode of the same build with no Supabase/auth/GHL settings; NET-1 and per-business audit isolation. Coverage of the remaining items (cookie refresh, invitation expiry, failure recovery) is mapped to stack tests in `docs/STAGING_CUTOVER_CHECKLIST.md` §4.

### 22.2 Defects found and fixed

1. **JSON endpoints accepted CORS-simple content types.** `POST /api/contacts` and `PATCH /api/contacts/{id}` wrote records from valid JSON sent as `text/plain`, a type a cross-site page can send without a preflight (SameSite=Lax cookies limit, but do not replace, this guard). `parseBody` (every native JSON route) now requires `application/json` or `application/*+json` and answers 422 `validation_failed` with `fields.body`; `readJsonObject` (login in both modes, workspace switch, logo endpoint JSON action) returns null, so those answer their existing 400/422. Every browser caller already sends `application/json`. Regression tests: unit `p5-crm` (text/plain, form, text/plain with charset, unset; nothing written) and `p2-auth` (login refuses text/plain, form, multipart before Auth is contacted). Legacy login is affected only for non-JSON requests, which its own page never sends.
2. **Legacy `/platform` answered 200.** The root `loading.tsx` streams every page, so the console's `notFound()` arrived after a 200 status. Supabase mode already decided this in middleware (P6); legacy and misconfigured modes now rewrite `/platform*` to the 404 page in middleware too. Regression test: unit `p6-platform` (four console paths, 404 with no redirect).
3. Test-side corrections (not product defects): the workspace-name check uses the authenticated `/api/tenant/config` (`/api/tenant/public` is generic by design, §7.3); the logout-replay test now pins the observed values instead of accepting a range.

### 22.3 Open items (not complete; no evidence of completion)

- **Logout replay** (decision open): after logout a replayed cookie read **200**, ordinary record write **200**, invitation **401** (fresh stack, acceptance test 14).
- **Migration-history reconciliation** on staging before any push (`docs/MIGRATION_VERSION_MAPPING.md`).
- **Platform-admin bootstrap script** (§6.4 A2, `scripts/bootstrap-platform-admin.ts`) was never written; all suites insert the row directly. Needed (or an approved manual step) for T2.
- MFA device-loss recovery; paid plan (D5); P7 deploy ordering and the `CLIENT_CONFIG_PATH`/`GHL_PIPELINE_ID` owner check; T6/M15 gates. All listed in `docs/STAGING_CUTOVER_CHECKLIST.md`.

### 22.4 Results (2026-11-01, this machine, final source)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite (240 + 1 new; 7 new assertions inside existing tests) | Node 24.20.0 | PASS 241/241 |
| DB suite | PGlite + shim | PASS 217/217 |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 |
| Stack suite | Real Supabase local stack (disposable) + `next build`/`next start` + Chromium | PASS 63/63 |
| Acceptance rehearsal | Fresh disposable Supabase stack + built app, two synthetic businesses; legacy-mode app on the same build | PASS 16/16, twice (direct and through `npm run test:acceptance`); first run 13/16 before the fixes above |
| UI-2 visual harness | disposable stack + built app + Chromium | 20/20 routes 200; sidebar 0.00% on every page; figures identical to §21.5 |
| `npm run typecheck` | — | PASS |
| `npm run build` | Next.js 15.5.25, no `GHL_*` variables in the environment | PASS |
| Browser bundle scan (`.next/static`) | — | no service-role names or values, `sb_secret_`, JWTs, private keys, CRM terms, or `GHL_`; `AUTH_SECRET` named once in the existing legacy login message (no value) |
| Secret scan of changed and new files | — | no secrets; matches are synthetic passwords for throwaway users on the disposable stack |
| Cleanup | Docker / temp | 0 containers, volumes, networks, or temp projects left |

## 23. Hardening rehearsal (six packets, local only)

Local only. All of it ran on fresh disposable Supabase stacks and a built app, with synthetic businesses and `example.test` addresses. No staging or production project, hosted service, deployment, push, or outbound message was involved. There are four suites: `tests/acceptance/hardening.test.ts` (packets 1–4), `backup-restore.test.ts` (packet 5) and `scale.test.ts` (packet 6), plus the existing acceptance journeys. The runner now runs acceptance and stack files one at a time (each starts its own stack) with a minimum of 33 tests.

### 23.1 Defects found and fixed (commits on `feat/native-multi-tenant`)

| Packet | Defect (observed) | Fix | Commit |
| --- | --- | --- | --- |
| 1 Workspaces and tabs | A tab still showing business A could read or save into business B after another tab switched | Every page pins its workspace (`X-FNA-Workspace`); a mismatch answers 409 `workspace_changed` and writes nothing; switching reloads the page; other tabs show a banner | `4939be8` |
| 2 Bookings and time zones | An edit could stretch an appointment past 24 hours or end before it started; times that do not exist (spring-forward) were silently shifted; card times were ambiguous | `updateAppointment` re-checks the duration against the stored row (422); the forms refuse skipped local times; native cards show `YYYY-MM-DD HH:MM UTC` | `02b3070` |
| 2 (diagnostics) | One run returned 503 instead of 409 to seven losing simultaneous bookings (one booking stored, correct) and could not be reproduced in 66 further rounds | Unmapped database failures now log their SQLSTATE and status only (never the message) | `c9a74ce` |
| 3 Browser usability | Dialogs did not trap focus or return it, and Escape did not close them; save errors appeared behind the open dialog or off screen; `/settings` overflowed 232 px at 390 px wide; mobile dialog buttons were unreachable; out-of-order search responses could replace newer results | Shared `Modal` (focus first field, Tab trapped, Escape, focus restored, alert scrolled into view); errors render inside the open dialog; `.grid > * { min-width: 0 }`; dialogs scroll within the viewport; superseded searches are ignored | `dbfd583` |
| 4 Failure and recovery | A write whose response was lost said "failed" though it might have been saved; refusals (expired session, removed permission, suspension) used technical wording; "Save note" could be submitted twice | Lost or ambiguous write responses say the outcome is unknown and ask for a reload before retrying; plain refusals that end "Nothing was saved."; single-submit guard | `781d9e2` |
| 5 Backup and restore | None in the product | Rehearsal tooling and `docs/BACKUP_RESTORE_REHEARSAL.md` | `7591aee` |
| 6 Scale | A year of a busy calendar answered 503: about 500 contact ids in one `in` filter exceed the gateway's URL limit (414; 100 ids answer 200) | Contact and display-name lookups go out in batches of 100 ids | `2de8d75` |

### 23.2 Verified without change

- Packet 1: browser back/forward, refresh, pagination cursors and cached pages stay on the pinned business.
- Packet 2:
  - Exclusive slots: 6 rounds of 8 simultaneous bookings give exactly one success and seven 409 `overlap` each round, plus concurrent reschedules.
  - Daylight-saving instants, midnight and month boundaries, and half-open adjacency all behave correctly.
  - Appointments stay on their exact calendar IDs; there is no cross-calendar or cross-business display.
- Packet 4:
  - Table locks give 503 after about 8 seconds with nothing written.
  - When the REST, Auth or Storage container is stopped, errors are honest: an Auth outage keeps existing sessions working (tokens are verified locally) and refuses new logins with 503; a Storage outage refuses logo saves with 502 `storage_failed`.
  - No response contained keys, tokens, cookies or SQL detail.
- Packet 6:
  - With 1,458 live contacts and more than 1,000 opportunities, tasks, conversations, messages, appointments, reviews and audit rows, every list returns each row exactly once in stable order across page boundaries inside 200–400 identical timestamps, with exact totals.
  - Search, tag, stage and status filters are exact.
  - Board, task and dashboard counts are exact beyond the 1,000-row cap.
  - Every page renders in 77–130 ms and every API call in 48–80 ms (median of 3 on this machine).
  - Statement counts differ from a small business only by the 1,000-row paging of exact totals (at most 6 more). No N+1 queries.

### 23.3 Open items

- The single unreproduced 503 in 23.1 remains unexplained. The added logging will capture its SQLSTATE if it recurs.
- Known limitations, kept by decision:
  - calendar cards show the five latest-dated bookings (original behaviour);
  - an appointment range returns at most 500 bookings and says `truncated` (month views are complete).
- Restores do not bring back passwords, sessions, MFA factors or integration secrets (`docs/BACKUP_RESTORE_REHEARSAL.md`).
- Everything in §22.3 is still open.

### 23.4 Results (2026-11-01, this machine, final source)

| Check | Environment | Result |
| --- | --- | --- |
| Unit suite | Node 24.20.0 | PASS 243/243 |
| DB suite | PGlite + shim | PASS 217/217 |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 28/28 |
| Stack suite | Real Supabase local stack (disposable) + built app + Chromium | PASS 63/63 |
| Acceptance rehearsals | Fresh disposable stacks + built app + Chromium (journeys, hardening, backup/restore across two stacks, scale) | PASS 33/33 |
| UI-2 visual harness | disposable stack + built app + Chromium | 20/20 routes 200; sidebar 0.00% on every page (settings/onboarding differences are the existing accepted ones) |
| `npm run typecheck` / `npm run build` | Next.js 15.5.25 | PASS / PASS |
| Browser bundle scan (`.next/static`, 112 files) | — | no service-role names or values, `sb_secret_`, JWTs, private keys, or GHL terms |
| Secret scan of every file changed in this run | — | no matches |

## 24. Local completion record

Local only, synthetic users, disposable stacks. Handoff, operators and remaining external actions: `docs/RELEASE_HANDOFF.md`.

### 24.1 Completed in this round (commits on `feat/native-multi-tenant`)

| Item | Commit |
| --- | --- |
| Codex review: availability replacement serialized per calendar (M20) with a two-session real-PostgreSQL regression; exact migration manifest (M1–M14, M16–M20 at that time; M15 excluded) | `a07650c` |
| M21: logout ends native access at once for reads, writes and direct Data API calls (`session_id` checked against `auth.sessions`; PostgREST pre-request check answers 401); stale cookies are expired; refreshed tokens and other sessions keep working | `e2f406d` |
| A2: platform-admin bootstrap and operator CLI (`grant`, `revoke`, `remove-mfa`, `list`); loopback-only for `--env local`; https, an interactive terminal and a typed phrase for any other target; keys from the environment only; last admin cannot be revoked; every change audited | `aa5c7f1` |
| Per-employee permission overrides UI, weekly business hours, private business logo (§6.6), full stage lists on the board | `7bf31c6` |
| Scale guard counts data statements without the per-request M21 check; suite minimums raised | `813367e` |
| Codex review of `9bed179`: M22 makes platform-admin grant/revoke atomic with the audit row and serialized on one advisory lock; the database refuses any change that leaves zero admins; `remove-mfa` records a start and the observed outcome (complete, partial, none, unknown) and only reports success when complete | `9317313` |
| Booking 503 root cause: simultaneous inserts of one slot deadlocked in the exclusion check (40P01 → 503). M23 takes a per-calendar lock first; real-PostgreSQL regression (60 × 8 inserts, 20 × 8 reschedules, no-lock control) | `2a232d9` |
| Invitation page: 15 s request timeout and a "Could not check this invitation / Try again" state (a network or server failure is no longer shown as an invalid link); 25-load stall reproduction with diagnostics in the stack suite | `4740681` |
| Runner: minimum file counts for directory-listed suites so a deleted test file cannot hide behind tests added elsewhere | `ab59783` |
| Final bug-finding pass, M24: removing a member or changing their role revokes their open invitations that the new role no longer allows (audited) | `1508fa4` |
| M25: no new or moved bookings on an inactive calendar, appointments at most 24 hours; `_` no longer a search wildcard; reports accept "from" without "to" | `fd2c2b3` |
| Client fixes: stale-tab logo upload carries the workspace pin; stale-pin refusal before role denials; board "Show more" lists reload after edits; calendar retry updates the created calendar; logout reports failure; paging guards; UTC labels on tasks | `012a024` |

### 24.2 Narrow decisions left open (not invented)

- Removing a platform admin who has used support access: `workspace_audit_log` references their grant (`platform_access_grants` cascades from `platform_admins`), so the revocation fails with a foreign-key error and changes nothing. Pre-existing; pinned by a PGlite test. Needs a retention decision (keep grants after removal, or deactivate admins instead of deleting).

- MFA recovery policy (who may run `remove-mfa`, how identity is confirmed). The mechanism exists; no self-service bypass or recovery codes were added.

### 24.3 Results (2026-11-01, final code `813367e`)

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | Next.js 15.5.25 | PASS / PASS |
| Unit suite | Node 24.20.0 | PASS 253/253 |
| DB suite | PGlite + shim (includes `auth.sessions`) | PASS 225/225 |
| Concurrency suite | Real local PostgreSQL 18.6 | PASS 31/31 |
| Stack suite | Real Supabase local stack (disposable) + built app + Chromium | PASS 67/67 on rerun; the first run failed 1/67 (see 24.4) |
| Acceptance rehearsals | Fresh disposable stacks + built app + Chromium (journeys, hardening, backup/restore, scale, product) | PASS 38/38 |
| UI-2 visual harness | disposable stack + built app + Chromium | 20/20 routes 200; sidebar 0.00% on every page; settings 61.98% (business hours and logo added), onboarding 62.71% |
| Browser bundle scan (`.next/static`, 113 files) | — | no service-role names or values, `sb_secret_`, JWTs, private keys, GHL terms, or the operator CLI |
| Secret scan of the 31 files changed after `a07650c` | — | no matches |

Re-run on `9317313` (M22): typecheck and build PASS; unit 257/257; PGlite 232/232; real PostgreSQL 35/35 (two-session revocation races, grant/revoke lock sharing, 20-round burst, no-lock control); Supabase stack 69/69 (CLI audit rollback, two concurrent CLI revocations); acceptance 38/38; bundle scan (113 files) and secret scan of the 12 changed files clean. UI-2 not re-run (no UI change).

Re-run on `ab59783` (M23, invitation page, runner): typecheck and build PASS; unit 258/258; PGlite 232/232; real PostgreSQL 38/38; Supabase stack 70/70 (on `4740681`; invitation page settled on 25/25 loads, median 378 ms, max 540 ms; retry state recovers); acceptance 38/38; bundle scan (113 files) and secret scan of 27 changed files clean.

Re-run on `012a024` (final bug-finding pass, M24, M25, client fixes), each suite on its own: typecheck and build PASS; unit 260/260; PGlite 237/237 (15 files); real PostgreSQL 38/38; Supabase stack 70/70; acceptance 39/39; bundle scan and secret scan of the diff since `2500c80` clean. Details: `docs/LOCAL_COMPLETION_REPORT.md` §7.

### 24.4 Open items

- Intermittent: once, the signed-out invitation page stayed on "Checking your invitation…" for 20 seconds. Not reproduced in 25 instrumented loads; the page now times out after 15 s and offers Try again instead of waiting forever.
- Everything in §22.3 and §23.3 that is not listed as done above.
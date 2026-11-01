-- M3: workspace membership, active workspace, invitations, platform access grants.

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'admin', 'employee')),
  status       text not null default 'active' check (status in ('active', 'removed')),
  invited_by   uuid references auth.users(id),
  joined_at    timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   uuid references auth.users(id),
  primary key (workspace_id, user_id),
  check ((status = 'removed') = (removed_at is not null))
);
create index workspace_members_user_idx on public.workspace_members (user_id) where status = 'active';

create table public.member_permission_overrides (
  workspace_id uuid not null,
  user_id      uuid not null,
  permission   text not null,
  allowed      boolean not null,
  primary key (workspace_id, user_id, permission),
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade,
  -- Overrides can never confer team management, integration credentials, or owner-only pages.
  check (not (allowed and (permission like 'team.%'
                           or permission in ('integrations.manage', 'onboarding.read'))))
);

create table public.user_active_workspace (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  updated_at   timestamptz not null default now()
);

create table public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        extensions.citext not null check (email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role         text not null check (role in ('owner', 'admin', 'employee')),
  token_hash   bytea not null unique,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id),
  revoked_at   timestamptz,
  unique (workspace_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check (not (accepted_at is not null and revoked_at is not null))
);
create unique index workspace_invitations_one_open_per_email
  on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

create table public.platform_access_grants (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  admin_user_id uuid not null references public.platform_admins(user_id) on delete cascade,
  mode          text not null check (mode in ('read', 'write')),
  reason        text not null check (length(reason) >= 10),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users(id),
  unique (workspace_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '8 hours')
);
create index platform_access_grants_lookup_idx
  on public.platform_access_grants (admin_user_id, workspace_id)
  where revoked_at is null;

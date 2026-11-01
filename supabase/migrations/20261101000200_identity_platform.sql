-- M2: global identity and platform tables (the only tables without workspace_id).

create table public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '' check (length(full_name) <= 120),
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id                    uuid primary key default gen_random_uuid(),
  slug                  extensions.citext not null unique
                          check (slug::text ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  name                  text not null check (length(name) between 1 and 120),
  status                text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  provisioning_key      text not null unique check (length(provisioning_key) between 3 and 120),
  bootstrap_owner_email extensions.citext not null,
  -- Set once, by trigger, when the first active owner joins. Bootstrap invitations can only be
  -- rotated while this is null.
  owner_acquired_at     timestamptz,
  created_by            uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  suspended_at          timestamptz,
  suspended_reason      text
);

-- Static reference data: which permissions each workspace role holds.
create table public.role_permissions (
  role       text not null check (role in ('owner', 'admin', 'employee')),
  permission text not null,
  primary key (role, permission)
);

-- Static reference data: which permissions a platform access grant confers.
create table public.grant_mode_permissions (
  mode       text not null check (mode in ('read', 'write')),
  permission text not null,
  primary key (mode, permission)
);

create table public.platform_audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid references auth.users(id),
  action       text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  reason       text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

insert into public.role_permissions (role, permission)
select 'owner', p from unnest(array[
  'dashboard.read', 'contacts.read', 'contacts.write', 'contacts.delete',
  'pipeline.read', 'opportunities.write', 'opportunities.delete', 'pipeline.configure',
  'calendar.read', 'appointments.write', 'calendar.configure',
  'conversations.read', 'conversations.write', 'tasks.read', 'tasks.write',
  'reviews.read', 'reports.read', 'automations.read', 'marketing.read', 'payments.read',
  'settings.read', 'settings.write', 'ai_receptionist.read', 'ai_receptionist.write',
  'integrations.read', 'integrations.manage',
  'team.read', 'team.invite_employee', 'team.invite_admin', 'team.invite_owner',
  'team.change_role', 'team.remove', 'team.manage_overrides',
  'audit.read', 'onboarding.read', 'library.read'
]) as p
union all
select 'admin', p from unnest(array[
  'dashboard.read', 'contacts.read', 'contacts.write', 'contacts.delete',
  'pipeline.read', 'opportunities.write', 'opportunities.delete', 'pipeline.configure',
  'calendar.read', 'appointments.write', 'calendar.configure',
  'conversations.read', 'conversations.write', 'tasks.read', 'tasks.write',
  'reviews.read', 'reports.read', 'automations.read', 'marketing.read', 'payments.read',
  'settings.read', 'settings.write', 'ai_receptionist.read', 'ai_receptionist.write',
  'integrations.read',
  'team.read', 'team.invite_employee', 'team.remove', 'team.manage_overrides',
  'audit.read', 'library.read'
]) as p
union all
select 'employee', p from unnest(array[
  'dashboard.read', 'contacts.read', 'contacts.write',
  'pipeline.read', 'opportunities.write',
  'calendar.read', 'appointments.write',
  'conversations.read', 'conversations.write', 'tasks.read', 'tasks.write',
  'reviews.read', 'reports.read', 'automations.read', 'marketing.read', 'payments.read',
  'settings.read', 'team.read'
]) as p;

insert into public.grant_mode_permissions (mode, permission)
select 'read', p from unnest(array[
  'dashboard.read', 'contacts.read', 'pipeline.read', 'calendar.read',
  'conversations.read', 'tasks.read', 'reviews.read', 'reports.read',
  'automations.read', 'marketing.read', 'payments.read', 'settings.read',
  'ai_receptionist.read', 'integrations.read', 'team.read', 'audit.read',
  'onboarding.read', 'library.read'
]) as p
union all
select 'write', p from unnest(array[
  'dashboard.read', 'contacts.read', 'pipeline.read', 'calendar.read',
  'conversations.read', 'tasks.read', 'reviews.read', 'reports.read',
  'automations.read', 'marketing.read', 'payments.read', 'settings.read',
  'ai_receptionist.read', 'integrations.read', 'team.read', 'audit.read',
  'onboarding.read', 'library.read',
  'contacts.write', 'contacts.delete', 'opportunities.write', 'opportunities.delete',
  'pipeline.configure', 'appointments.write', 'calendar.configure',
  'conversations.write', 'tasks.write', 'settings.write', 'ai_receptionist.write',
  'team.invite_employee'
]) as p;

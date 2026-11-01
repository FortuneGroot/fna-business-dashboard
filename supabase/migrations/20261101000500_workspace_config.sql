-- M5: per-workspace configuration.

create table public.workspace_settings (
  workspace_id   uuid primary key references public.workspaces(id) on delete cascade,
  business_name  text not null check (length(business_name) between 1 and 120),
  legal_name     text not null default '',
  timezone       text not null default 'America/New_York',
  industry       text not null default '',
  support_email  extensions.citext,
  business_phone text,
  website_url    text,
  booking_url    text,
  review_url     text,
  brand_colors   jsonb not null default '{}',
  logo_path      text,
  business_hours jsonb not null default '{}',
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id)
);

-- Enablement stays blocked until a trusted provider verification flow and a receptionist runtime
-- exist; lifting it requires a reviewed migration that replaces this constraint.
create table public.ai_receptionist_configs (
  workspace_id        uuid primary key references public.workspaces(id) on delete cascade,
  enabled             boolean not null default false
                        constraint ai_receptionist_disabled_until_runtime check (enabled = false),
  greeting            text not null default '',
  business_hours_mode text not null default 'business_hours'
                        check (business_hours_mode in ('always', 'business_hours', 'off')),
  escalation_user_id  uuid,
  faq                 jsonb not null default '[]',
  voice               text not null default 'default',
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users(id),
  foreign key (workspace_id, escalation_user_id)
    references public.workspace_members (workspace_id, user_id)
);

create table public.integrations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider     text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  -- status, capabilities, and verified_at are set only by trusted server-side verification
  -- (service role); clients have no grants on them and a trigger resets them on client writes.
  status       text not null default 'disconnected' check (status in ('disconnected', 'connected', 'error')),
  capabilities text[] not null default '{}',
  verified_at  timestamptz,
  config       jsonb not null default '{}',
  connected_by uuid references auth.users(id),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, provider),
  unique (workspace_id, id),
  constraint integrations_connected_requires_verification
    check (status <> 'connected' or verified_at is not null)
);

-- Encrypted credentials. RLS forced with no policies and no grants: service role only.
create table public.integration_secrets (
  integration_id uuid primary key,
  workspace_id   uuid not null,
  ciphertext     bytea not null,
  key_version    int not null check (key_version > 0),
  updated_at     timestamptz not null default now(),
  foreign key (workspace_id, integration_id)
    references public.integrations (workspace_id, id) on delete cascade
);

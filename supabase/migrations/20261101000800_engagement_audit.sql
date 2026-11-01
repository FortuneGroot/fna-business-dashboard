-- M8: conversations, messages, tasks, reviews, activity and audit logs.

create table public.conversations (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  contact_id       uuid not null,
  channel          text not null check (channel in ('sms', 'email', 'call', 'webchat', 'internal')),
  status           text not null default 'open' check (status in ('open', 'closed')),
  assigned_user_id uuid,
  last_message_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id),
  foreign key (workspace_id, assigned_user_id)
    references public.workspace_members (workspace_id, user_id)
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  conversation_id uuid not null,
  direction       text not null check (direction in ('inbound', 'outbound', 'internal')),
  body            text not null check (length(body) between 1 and 20000),
  -- Stamped by private.stamp_author() for user writes (see contact_notes).
  author_user_id  uuid references auth.users(id),
  author_grant_id uuid,
  delivery_status text not null default 'not_sent'
                    check (delivery_status in ('not_sent', 'queued', 'sent', 'delivered', 'failed')),
  created_at      timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, conversation_id)
    references public.conversations (workspace_id, id) on delete cascade,
  foreign key (workspace_id, author_grant_id)
    references public.platform_access_grants (workspace_id, id)
);

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  title            text not null check (length(title) between 1 and 200),
  description      text not null default '' check (length(description) <= 10000),
  due_at           timestamptz,
  status           text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  contact_id       uuid,
  opportunity_id   uuid,
  assigned_user_id uuid,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id),
  foreign key (workspace_id, opportunity_id)
    references public.opportunities (workspace_id, id),
  foreign key (workspace_id, assigned_user_id)
    references public.workspace_members (workspace_id, user_id)
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
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id)
);

create table public.activity_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  entity_type  text not null,
  entity_id    uuid,
  action       text not null,
  actor_id     uuid references auth.users(id),
  actor_kind   text not null check (actor_kind in ('member', 'platform_admin', 'system')),
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index activity_events_workspace_idx on public.activity_events (workspace_id, created_at desc);

create table public.workspace_audit_log (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id     uuid references auth.users(id),
  actor_kind   text not null check (actor_kind in ('member', 'platform_admin', 'system')),
  grant_id     uuid,
  action       text not null,
  target       text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, grant_id)
    references public.platform_access_grants (workspace_id, id)
);
create index workspace_audit_log_workspace_idx on public.workspace_audit_log (workspace_id, created_at desc);

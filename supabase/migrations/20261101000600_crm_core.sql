-- M6: contacts, tags, notes, pipelines, stages, opportunities.
-- Every cross-table reference carries workspace_id so the database rejects cross-workspace links.

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  first_name    text not null default '' check (length(first_name) <= 100),
  last_name     text not null default '' check (length(last_name) <= 100),
  email         extensions.citext,
  phone         text check (phone is null or length(phone) <= 40),
  source        text not null default 'manual' check (length(source) <= 60),
  owner_user_id uuid,
  dnd           boolean not null default false,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (workspace_id, id),
  check (email is not null or phone is not null or (first_name || last_name) <> ''),
  foreign key (workspace_id, owner_user_id)
    references public.workspace_members (workspace_id, user_id)
);
create unique index contacts_email_per_workspace
  on public.contacts (workspace_id, email) where email is not null and deleted_at is null;
create index contacts_workspace_idx on public.contacts (workspace_id, created_at desc);

create table public.contact_tags (
  workspace_id uuid not null,
  contact_id   uuid not null,
  tag          extensions.citext not null check (length(tag::text) between 1 and 60),
  primary key (workspace_id, contact_id, tag),
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id) on delete cascade
);

create table public.contact_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  contact_id   uuid not null,
  body         text not null check (length(body) between 1 and 10000),
  -- Stamped from the caller's identity by private.stamp_author(): an active member, or a platform
  -- admin writing under a write grant (author_grant_id records which grant).
  author_id       uuid not null references auth.users(id),
  author_grant_id uuid,
  created_at   timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id) on delete cascade,
  foreign key (workspace_id, author_grant_id)
    references public.platform_access_grants (workspace_id, id)
);
create index contact_notes_contact_idx on public.contact_notes (workspace_id, contact_id);

create table public.pipelines (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (length(name) between 1 and 120),
  is_default   boolean not null default false,
  unique (workspace_id, id)
);
create unique index pipelines_one_default
  on public.pipelines (workspace_id) where is_default;

create table public.pipeline_stages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  pipeline_id  uuid not null,
  name         text not null check (length(name) between 1 and 60),
  position     smallint not null check (position between 1 and 12),
  kind         text not null check (kind in ('open', 'won', 'lost', 'nurture')),
  unique (pipeline_id, position),
  unique (workspace_id, pipeline_id, id),
  unique (workspace_id, id),
  foreign key (workspace_id, pipeline_id)
    references public.pipelines (workspace_id, id) on delete cascade
);

create table public.opportunities (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  contact_id       uuid not null,
  pipeline_id      uuid not null,
  stage_id         uuid not null,
  title            text not null check (length(title) between 1 and 200),
  value_cents      bigint not null default 0 check (value_cents >= 0),
  currency         char(3) not null default 'USD',
  status           text not null default 'open' check (status in ('open', 'won', 'lost')),
  assigned_user_id uuid,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz,
  deleted_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id),
  foreign key (workspace_id, pipeline_id, stage_id)
    references public.pipeline_stages (workspace_id, pipeline_id, id),
  foreign key (workspace_id, assigned_user_id)
    references public.workspace_members (workspace_id, user_id)
);
create index opportunities_stage_idx on public.opportunities (workspace_id, stage_id);

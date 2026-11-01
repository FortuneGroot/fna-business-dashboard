-- M7: calendars, availability, appointments.

create table public.calendars (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  name             text not null check (length(name) between 1 and 120),
  slug             extensions.citext not null check (slug::text ~ '^[a-z0-9-]{1,60}$'),
  timezone         text not null default 'America/New_York',
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
  foreign key (workspace_id, calendar_id)
    references public.calendars (workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id)
);

create table public.availability_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  calendar_id  uuid not null,
  weekday      smallint not null check (weekday between 0 and 6),
  start_time   time not null,
  end_time     time not null,
  check (end_time > start_time),
  foreign key (workspace_id, calendar_id)
    references public.calendars (workspace_id, id) on delete cascade
);

create table public.appointments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  calendar_id      uuid not null,
  contact_id       uuid not null,
  opportunity_id   uuid,
  assigned_user_id uuid,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'booked'
                     check (status in ('booked', 'confirmed', 'completed', 'cancelled', 'no_show')),
  notes            text not null default '' check (length(notes) <= 10000),
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (workspace_id, id),
  check (ends_at > starts_at),
  foreign key (workspace_id, calendar_id)
    references public.calendars (workspace_id, id),
  foreign key (workspace_id, contact_id)
    references public.contacts (workspace_id, id),
  foreign key (workspace_id, opportunity_id)
    references public.opportunities (workspace_id, id),
  foreign key (workspace_id, assigned_user_id)
    references public.workspace_members (workspace_id, user_id),
  constraint appointments_no_overlap exclude using gist (
    calendar_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('booked', 'confirmed') and deleted_at is null)
);
create index appointments_range_idx on public.appointments (workspace_id, starts_at);

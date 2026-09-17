-- Durable F&A sync store (Supabase / Postgres)
-- Location-isolated. Do NOT run against production unless owner-authorized.
-- Live location only: kIXDnRuhkj6HLR1g6V6V
-- Protected Master NQwD3zdWCuBSVpOuzybj must never be written.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- sync_contacts
-- ---------------------------------------------------------------------------
create table if not exists public.sync_contacts (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  external_contact_id text not null,
  first_name text,
  last_name text,
  display_name text,
  email text,
  phone text,
  source text,
  assigned_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  constraint sync_contacts_location_external unique (location_id, external_contact_id),
  constraint sync_contacts_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_contacts_location_idx on public.sync_contacts (location_id);
create index if not exists sync_contacts_external_idx on public.sync_contacts (external_contact_id);
create index if not exists sync_contacts_updated_idx on public.sync_contacts (location_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- sync_contact_tags
-- ---------------------------------------------------------------------------
create table if not exists public.sync_contact_tags (
  contact_id uuid not null references public.sync_contacts (id) on delete cascade,
  tag text not null,
  primary key (contact_id, tag)
);

create index if not exists sync_contact_tags_tag_idx on public.sync_contact_tags (tag);

-- ---------------------------------------------------------------------------
-- sync_opportunities
-- ---------------------------------------------------------------------------
create table if not exists public.sync_opportunities (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  external_opportunity_id text not null,
  external_contact_id text,
  pipeline_id text,
  stage_id text,
  stage_name text,
  status text,
  monetary_value numeric,
  assigned_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  constraint sync_opportunities_location_external unique (location_id, external_opportunity_id),
  constraint sync_opportunities_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_opportunities_location_idx on public.sync_opportunities (location_id);
create index if not exists sync_opportunities_external_idx on public.sync_opportunities (external_opportunity_id);
create index if not exists sync_opportunities_contact_idx on public.sync_opportunities (location_id, external_contact_id);
create index if not exists sync_opportunities_updated_idx on public.sync_opportunities (location_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- sync_appointments
-- ---------------------------------------------------------------------------
create table if not exists public.sync_appointments (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  external_appointment_id text not null,
  external_contact_id text,
  calendar_id text,
  calendar_name text,
  status text,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  assigned_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  constraint sync_appointments_location_external unique (location_id, external_appointment_id),
  constraint sync_appointments_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_appointments_location_idx on public.sync_appointments (location_id);
create index if not exists sync_appointments_external_idx on public.sync_appointments (external_appointment_id);
create index if not exists sync_appointments_start_idx on public.sync_appointments (location_id, start_at desc);

-- ---------------------------------------------------------------------------
-- sync_conversation_events
-- ---------------------------------------------------------------------------
create table if not exists public.sync_conversation_events (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  external_contact_id text,
  direction text,
  channel text,
  event_type text not null,
  summary text,
  occurred_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  constraint sync_conversation_events_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_conversation_events_location_idx
  on public.sync_conversation_events (location_id, occurred_at desc);
create index if not exists sync_conversation_events_contact_idx
  on public.sync_conversation_events (location_id, external_contact_id);

-- ---------------------------------------------------------------------------
-- sync_tasks
-- ---------------------------------------------------------------------------
create table if not exists public.sync_tasks (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  external_contact_id text,
  external_opportunity_id text,
  task_type text,
  status text,
  assigned_user_id text,
  occurred_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  constraint sync_tasks_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_tasks_location_idx on public.sync_tasks (location_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- sync_review_events
-- ---------------------------------------------------------------------------
create table if not exists public.sync_review_events (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  external_contact_id text,
  kind text not null,
  result_status text,
  occurred_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  constraint sync_review_events_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_review_events_location_idx
  on public.sync_review_events (location_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- sync_events (audit trail)
-- ---------------------------------------------------------------------------
create table if not exists public.sync_events (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  idempotency_key text not null,
  event_type text not null,
  source_event_name text,
  external_contact_id text,
  external_opportunity_id text,
  external_appointment_id text,
  note text,
  received_at timestamptz not null default now(),
  constraint sync_events_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_events_location_received_idx
  on public.sync_events (location_id, received_at desc);
create index if not exists sync_events_type_idx on public.sync_events (location_id, event_type);

-- ---------------------------------------------------------------------------
-- sync_idempotency
-- ---------------------------------------------------------------------------
create table if not exists public.sync_idempotency (
  location_id text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  primary key (location_id, idempotency_key),
  constraint sync_idempotency_location_not_master check (location_id <> 'NQwD3zdWCuBSVpOuzybj')
);

create index if not exists sync_idempotency_created_idx
  on public.sync_idempotency (location_id, created_at desc);

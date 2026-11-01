-- TEST ONLY. Minimal stand-in for objects a Supabase database already provides, so the
-- repository migrations can be applied to an empty local PGlite database.
-- Never apply this file to a Supabase project.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}',
  created_at         timestamptz not null default now()
);

-- Same claim resolution as Supabase's auth.uid() / auth.jwt().
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.email() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Migrations run as a non-superuser role with BYPASSRLS, mirroring Supabase's `postgres` role, so
-- SECURITY DEFINER functions are owned by a role that is not a superuser.
create role migration_owner nologin bypassrls;
do $$
begin
  execute format('grant create on database %I to migration_owner', current_database());
end;
$$;
grant usage, create on schema public to migration_owner;
grant usage, create on schema extensions to migration_owner;
grant usage on schema auth to migration_owner;
grant select, references, trigger on auth.users to migration_owner;
grant anon, authenticated, service_role to migration_owner;

-- Minimal Supabase Storage tables (owned by a separate admin role, like supabase_storage_admin).
-- Storage API requests run as anon/authenticated with JWT claims, which tests simulate directly.
-- Only the real local Supabase stack proves the Storage API itself.
create role storage_admin nologin noinherit;
create schema storage authorization storage_admin;
create table storage.buckets (
  id         text primary key,
  name       text not null unique,
  public     boolean not null default false,
  created_at timestamptz not null default now()
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner_id   text,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket_id, name)
);
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare
  _parts text[] := string_to_array(name, '/');
begin
  return _parts[1:array_length(_parts, 1) - 1];
end;
$$;
alter table storage.buckets owner to storage_admin;
alter table storage.objects owner to storage_admin;
alter function storage.foldername(text) owner to storage_admin;
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
-- Supabase lets the migration role add policies, triggers, and buckets on storage tables.
grant storage_admin to migration_owner;

-- Supabase's default privileges on the public schema (migrations must revoke what they do not want).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role migration_owner in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role migration_owner in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role migration_owner in schema public grant all on functions to anon, authenticated, service_role;

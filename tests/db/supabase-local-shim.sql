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

-- Supabase's default privileges on the public schema (migrations must revoke what they do not want).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role migration_owner in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role migration_owner in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role migration_owner in schema public grant all on functions to anon, authenticated, service_role;

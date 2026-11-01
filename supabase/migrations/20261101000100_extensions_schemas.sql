-- M1: extensions and schemas for the native multi-tenant model.
-- Additive only. Does not touch legacy sync_* or auth_sessions tables.

create schema if not exists extensions;
create extension if not exists citext with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- Helper functions used by RLS policies and RPCs. Not exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

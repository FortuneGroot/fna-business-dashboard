-- M22: platform-admin changes are serialized, atomic with their audit record, and can never
-- leave zero platform admins.
--
-- Locking convention: every change to public.platform_admins takes the transaction-scoped
-- advisory lock private.lock_platform_admins() before it reads or writes the table. The operator
-- functions below take it first; the statement trigger takes it for any other writer (Data API,
-- SQL, cascades), so concurrent changes run one after another and each sees the other's result.

create or replace function private.lock_platform_admins()
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fna.platform_admins', 0));
$$;

create or replace function private.platform_admins_serialize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_platform_admins();
  return null;
end;
$$;

-- Runs after the lock is held; under READ COMMITTED this query sees every change committed by a
-- transaction that held the lock before this one.
create or replace function private.platform_admins_keep_one()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from removed) and not exists (select 1 from public.platform_admins) then
    raise exception 'last_platform_admin: at least one platform admin must remain' using errcode = '23514';
  end if;
  return null;
end;
$$;

create or replace function private.platform_admins_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'last_platform_admin: at least one platform admin must remain' using errcode = '23514';
end;
$$;

create trigger platform_admins_serialize
  before insert or update or delete on public.platform_admins
  for each statement execute function private.platform_admins_serialize();

create trigger platform_admins_keep_one
  after delete on public.platform_admins
  referencing old table as removed
  for each statement execute function private.platform_admins_keep_one();

create trigger platform_admins_no_truncate
  before truncate on public.platform_admins
  for each statement execute function private.platform_admins_no_truncate();

-- Operator functions (service role only; used by scripts/bootstrap-platform-admin.ts). Each change
-- and its platform_audit_log row commit together or not at all.

create or replace function public.platform_admin_grant(p_user_id uuid, p_metadata jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added integer;
begin
  if p_user_id is null or jsonb_typeof(coalesce(p_metadata, '{}')) <> 'object' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.lock_platform_admins();
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.platform_admins (user_id) values (p_user_id) on conflict (user_id) do nothing;
  get diagnostics v_added = row_count;
  if v_added > 0 then
    insert into public.platform_audit_log (actor_id, action, reason, metadata)
    values (null, 'platform.admin_granted', null,
            coalesce(p_metadata, '{}') || jsonb_build_object('user_id', p_user_id));
  end if;
  return jsonb_build_object('changed', v_added > 0, 'admins', (select count(*) from public.platform_admins));
end;
$$;

create or replace function public.platform_admin_revoke(p_user_id uuid, p_reason text, p_metadata jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_user_id is null or length(v_reason) not between 5 and 500
     or jsonb_typeof(coalesce(p_metadata, '{}')) <> 'object' then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.lock_platform_admins();
  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    return jsonb_build_object('changed', false, 'admins', (select count(*) from public.platform_admins));
  end if;
  if (select count(*) from public.platform_admins) <= 1 then
    raise exception 'last_platform_admin: at least one platform admin must remain' using errcode = '23514';
  end if;
  delete from public.platform_admins pa where pa.user_id = p_user_id;
  insert into public.platform_audit_log (actor_id, action, reason, metadata)
  values (null, 'platform.admin_revoked', v_reason,
          coalesce(p_metadata, '{}') || jsonb_build_object('user_id', p_user_id));
  return jsonb_build_object('changed', true, 'admins', (select count(*) from public.platform_admins));
end;
$$;

revoke all on function private.lock_platform_admins() from public, anon, authenticated;
revoke all on function private.platform_admins_serialize() from public, anon, authenticated;
revoke all on function private.platform_admins_keep_one() from public, anon, authenticated;
revoke all on function private.platform_admins_no_truncate() from public, anon, authenticated;
revoke all on function public.platform_admin_grant(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.platform_admin_revoke(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.platform_admin_grant(uuid, jsonb) to service_role;
grant execute on function public.platform_admin_revoke(uuid, text, jsonb) to service_role;

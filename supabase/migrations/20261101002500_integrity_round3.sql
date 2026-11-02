-- M26: authority and integrity fixes from the third review round.
--
-- 1. An open invitation is honoured only while its issuer could still issue it. M24 revoked a
--    member's invitations when they were removed or demoted; invitations issued under a platform
--    write grant, and bootstrap owner invitations, still outlived the grant or the issuer's platform
--    role. Acceptance (and the signup and preview checks) now re-check the issuer's current authority,
--    under row locks that serialize with grant revocation and platform-admin removal. Acceptance also
--    requires a confirmed email address, and repeating an acceptance whose response was lost returns
--    the same result for the same user instead of invitation_used.
-- 2. Removing a platform admin who ever held a grant failed: the grant rows cascaded from
--    platform_admins and are referenced by authored notes, messages and audit rows. Grants now
--    reference the auth user (history stays attributed), and removal ends every open grant in the
--    same transaction as the removal and its audit record.
-- 3. A booking racing a calendar deactivation could land on the inactive calendar: the rule now
--    reads the calendar under a share lock, so the two serialize.
-- 4. The workspace logo is recorded only through public.set_workspace_logo, which swaps logo_path
--    under a row lock after checking the object exists, and returns the previous path for removal.
--    Member and platform uploads use unique object names, so concurrent replacements and deletions
--    can no longer remove each other's object.
-- 5. Append-only tables also refuse TRUNCATE; the AAL1 escape hatch for platform admins is removed;
--    own-profile and workspace-name visibility also require a live session.

-- ---------------------------------------------------------------------------
-- 1. Invitation issuer authority
-- ---------------------------------------------------------------------------

-- Whether the issuer of `p_inv` could issue it now. Members: active membership whose role, adjusted
-- by overrides, holds the invitation permission (members take precedence, as in has_permission).
-- Platform admins: a live grant in the workspace whose mode holds the permission, or, for an owner
-- invitation from an admin who was never a member there, the bootstrap authority of provisioning and
-- rotation. With p_lock, the issuer's membership, grants and platform-admin row are share-locked
-- first, so a concurrent removal, demotion, grant revocation or admin removal either commits before
-- this check (and is seen) or waits until the caller's transaction ends.
create function private.invitation_issuer_authorized(p_inv public.workspace_invitations, p_lock boolean)
returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_perm text := private.invitation_permission(p_inv.role);
  v_role text;
  v_override boolean;
begin
  if p_inv.created_by is null or v_perm is null then
    return false;
  end if;
  if p_lock then
    perform 1 from public.workspace_members m
      where m.workspace_id = p_inv.workspace_id and m.user_id = p_inv.created_by for share;
    perform 1 from public.platform_access_grants g
      where g.workspace_id = p_inv.workspace_id and g.admin_user_id = p_inv.created_by and g.revoked_at is null
      order by g.id for share;
    perform 1 from public.platform_admins pa where pa.user_id = p_inv.created_by for share;
  end if;

  select m.role into v_role from public.workspace_members m
  where m.workspace_id = p_inv.workspace_id and m.user_id = p_inv.created_by and m.status = 'active';
  if v_role is not null then
    select o.allowed into v_override from public.member_permission_overrides o
    where o.workspace_id = p_inv.workspace_id and o.user_id = p_inv.created_by and o.permission = v_perm;
    return coalesce(v_override, exists (
      select 1 from public.role_permissions rp where rp.role = v_role and rp.permission = v_perm));
  end if;

  if not exists (select 1 from public.platform_admins pa where pa.user_id = p_inv.created_by) then
    return false;
  end if;
  if exists (
    select 1 from public.platform_access_grants g
    join public.grant_mode_permissions gp on gp.mode = g.mode and gp.permission = v_perm
    where g.workspace_id = p_inv.workspace_id and g.admin_user_id = p_inv.created_by
      and g.revoked_at is null and g.expires_at > now()) then
    return true;
  end if;
  return p_inv.role = 'owner' and not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_inv.workspace_id and m.user_id = p_inv.created_by);
end;
$$;

revoke all on function private.invitation_issuer_authorized(public.workspace_invitations, boolean) from public, anon, authenticated;

create or replace function public.peek_invitation(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_inv public.workspace_invitations;
  v_name text;
  v_status text;
begin
  select * into v_inv from public.workspace_invitations i where i.token_hash = private.hash_token(p_token);
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select w.name into v_name from public.workspaces w where w.id = v_inv.workspace_id;
  v_status := case
    when v_inv.revoked_at is not null then 'revoked'
    when v_inv.accepted_at is not null then 'used'
    when v_inv.expires_at <= now() then 'expired'
    when not private.invitation_issuer_authorized(v_inv, false) then 'revoked'
    else 'valid' end;
  return jsonb_build_object(
    'status', v_status,
    'workspace_name', v_name,
    'role', v_inv.role,
    'email_masked', left(v_inv.email::text, 1) || '***@' || split_part(v_inv.email::text, '@', 2),
    'account_exists', exists (select 1 from auth.users u where lower(u.email::text) = lower(v_inv.email::text))
  );
end;
$$;

create or replace function public.invitation_signup_email(p_token text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_inv public.workspace_invitations;
begin
  select * into v_inv from public.workspace_invitations i where i.token_hash = private.hash_token(p_token);
  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0001';
  elsif v_inv.revoked_at is not null then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  elsif v_inv.accepted_at is not null then
    raise exception 'invitation_used' using errcode = 'P0001';
  elsif v_inv.expires_at <= now() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  elsif not exists (select 1 from public.workspaces w where w.id = v_inv.workspace_id and w.status = 'active') then
    raise exception 'workspace_suspended' using errcode = 'P0001';
  elsif not private.invitation_issuer_authorized(v_inv, false) then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  elsif exists (select 1 from auth.users u where lower(u.email::text) = lower(v_inv.email::text)) then
    raise exception 'conflict' using errcode = '23505';
  end if;
  return lower(v_inv.email::text);
end;
$$;

-- Same as M11, plus: the issuer's authority is re-checked under lock; the account's email must be
-- confirmed (the invitation signup path creates it confirmed, since holding the token mailed to that
-- address is the proof of control); and the same user repeating an acceptance whose response was lost
-- gets the same result while their membership from it is still active.
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_email text;
  v_confirmed boolean;
  v_inv public.workspace_invitations;
  v_existing public.workspace_members;
begin
  select lower(u.email::text), u.email_confirmed_at is not null into v_email, v_confirmed
  from auth.users u where u.id = v_uid;

  -- Workspace lock first (same order as every other membership path), then the invitation row.
  perform private.lock_workspace_membership(i.workspace_id)
  from public.workspace_invitations i where i.token_hash = private.hash_token(p_token);

  select * into v_inv from public.workspace_invitations i
  where i.token_hash = private.hash_token(p_token)
  for update;

  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0001';
  elsif v_inv.accepted_at is not null and v_inv.accepted_by = v_uid and exists (
      select 1 from public.workspace_members m
      where m.workspace_id = v_inv.workspace_id and m.user_id = v_uid and m.status = 'active') then
    insert into public.user_active_workspace (user_id, workspace_id, updated_at)
    values (v_uid, v_inv.workspace_id, now())
    on conflict (user_id) do update set workspace_id = excluded.workspace_id, updated_at = now();
    return public.request_context();
  elsif v_inv.revoked_at is not null then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  elsif v_inv.accepted_at is not null then
    raise exception 'invitation_used' using errcode = 'P0001';
  elsif v_inv.expires_at <= now() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  elsif v_email is null or v_email <> lower(v_inv.email::text) then
    raise exception 'invitation_email_mismatch' using errcode = 'P0001';
  elsif not coalesce(v_confirmed, false) then
    raise exception 'invitation_email_unverified' using errcode = 'P0001';
  elsif not exists (select 1 from public.workspaces w where w.id = v_inv.workspace_id and w.status = 'active') then
    raise exception 'workspace_suspended' using errcode = 'P0001';
  elsif not private.invitation_issuer_authorized(v_inv, true) then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  end if;

  update public.workspace_invitations
    set accepted_at = now(), accepted_by = v_uid
    where id = v_inv.id and accepted_at is null and revoked_at is null;
  if not found then
    raise exception 'invitation_used' using errcode = 'P0001';
  end if;

  select * into v_existing from public.workspace_members m
  where m.workspace_id = v_inv.workspace_id and m.user_id = v_uid;

  if found and v_existing.status = 'active' then
    raise exception 'already_member' using errcode = '23505';
  elsif found then
    update public.workspace_members
      set role = v_inv.role, status = 'active', removed_at = null, removed_by = null,
          invited_by = v_inv.created_by, joined_at = now()
      where workspace_id = v_inv.workspace_id and user_id = v_uid;
  else
    insert into public.workspace_members (workspace_id, user_id, role, invited_by)
    values (v_inv.workspace_id, v_uid, v_inv.role, v_inv.created_by);
  end if;

  insert into public.user_active_workspace (user_id, workspace_id, updated_at)
  values (v_uid, v_inv.workspace_id, now())
  on conflict (user_id) do update set workspace_id = excluded.workspace_id, updated_at = now();

  perform private.write_audit(v_inv.workspace_id, 'invitation.accepted', v_inv.id::text,
                              jsonb_build_object('role', v_inv.role));

  return public.request_context();
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Platform-admin removal keeps grant history and ends open grants
-- ---------------------------------------------------------------------------

-- Grants outlive the admin role (they are referenced by authored notes, messages and audit rows).
-- Deleting the auth user of someone with grant history is refused by this key: disable (ban) the
-- account instead. Access always also requires private.is_platform_admin().
alter table public.platform_access_grants
  drop constraint platform_access_grants_admin_user_id_fkey,
  add constraint platform_access_grants_admin_user_id_fkey foreign key (admin_user_id) references auth.users (id);

-- Same as M22, plus: every open grant of the removed admin is ended (revoked by the system) and
-- recorded in its workspace's audit log, and the platform audit row lists the ended grant ids.
create or replace function public.platform_admin_revoke(p_user_id uuid, p_reason text, p_metadata jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ended jsonb;
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

  with ended as (
    update public.platform_access_grants g
      set revoked_at = now()
      where g.admin_user_id = p_user_id and g.revoked_at is null and g.expires_at > now()
      returning g.id, g.workspace_id, g.mode
  ), audited as (
    insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, metadata)
    select e.workspace_id, null, 'system', e.id, 'platform.access_revoked',
           jsonb_build_object('reason', 'platform_admin_removed', 'mode', e.mode)
    from ended e
    returning 1
  )
  select coalesce(jsonb_agg(e.id order by e.id), '[]'::jsonb) into v_ended from ended e;

  delete from public.platform_admins pa where pa.user_id = p_user_id;
  insert into public.platform_audit_log (actor_id, action, reason, metadata)
  values (null, 'platform.admin_revoked', v_reason,
          coalesce(p_metadata, '{}') || jsonb_build_object('user_id', p_user_id, 'ended_grant_ids', v_ended));
  return jsonb_build_object('changed', true, 'admins', (select count(*) from public.platform_admins),
                            'ended_grant_ids', v_ended);
end;
$$;

revoke all on function public.platform_admin_revoke(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.platform_admin_revoke(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Bookings serialize with calendar deactivation
-- ---------------------------------------------------------------------------

-- Same as M25, but the calendar is read under a share lock: a deactivation in progress makes the
-- booking wait and then see it; a booking in progress makes the deactivation wait.
create or replace function private.appointment_rules()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_moved boolean := tg_op = 'INSERT' or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
                     or new.calendar_id <> old.calendar_id;
  v_takes_slot boolean;
  v_active boolean;
begin
  if v_moved and new.ends_at - new.starts_at > interval '24 hours' then
    raise exception 'appointment_too_long' using errcode = '23514';
  end if;
  v_takes_slot := new.status in ('booked', 'confirmed') and new.deleted_at is null
    and (v_moved or old.status not in ('booked', 'confirmed') or old.deleted_at is not null);
  if v_takes_slot then
    select c.active into v_active from public.calendars c where c.id = new.calendar_id for share;
    if not coalesce(v_active, false) then
      raise exception 'calendar_inactive' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Workspace logo: one recorded object, swapped atomically
-- ---------------------------------------------------------------------------

alter table public.workspace_settings
  add constraint workspace_settings_logo_path_format check (
    logo_path is null
    or logo_path ~ ('^' || workspace_id::text
                    || '/logo(-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(png|jpg|webp)$'));

revoke update (logo_path) on public.workspace_settings from authenticated;

-- Records `p_path` (an existing object of the active workspace, or null) as the logo and returns the
-- previous path, which the caller removes. With p_only_if, changes nothing unless the current path is
-- exactly that one. The settings row lock serializes concurrent swaps; the change is recorded by the
-- workspace_settings triggers like any settings change.
create function public.set_workspace_logo(p_path text, p_only_if text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
  v_old text;
begin
  perform private.require_permission('settings.write');
  if p_path is not null and p_path !~ ('^' || v_ws::text
       || '/logo(-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(png|jpg|webp)$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select s.logo_path into v_old from public.workspace_settings s where s.workspace_id = v_ws for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_only_if is not null and v_old is distinct from p_only_if then
    return jsonb_build_object('previous', v_old, 'changed', false);
  end if;
  if p_path is not null and not exists (
      select 1 from storage.objects o where o.bucket_id = 'workspace-assets' and o.name = p_path) then
    raise exception 'logo_missing' using errcode = 'P0002';
  end if;
  if v_old is distinct from p_path then
    update public.workspace_settings set logo_path = p_path where workspace_id = v_ws;
  end if;
  return jsonb_build_object('previous', v_old, 'changed', v_old is distinct from p_path);
end;
$$;

revoke all on function public.set_workspace_logo(text, text) from public, anon;
grant execute on function public.set_workspace_logo(text, text) to authenticated;

-- Same as M16, but also accepts the unique logo names.
create or replace function public.platform_storage_change_requested(p_operation text, p_object_path text)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_platform_admin();
  v_ws uuid := private.active_workspace_id();
  v_id bigint;
begin
  if p_operation is null or p_operation not in ('upsert', 'delete') or p_object_path is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if v_ws is null
     or private.active_member_role(v_ws) is not null
     or private.active_grant_mode(v_ws) is distinct from 'write' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_object_path !~ ('^' || v_ws::text
       || '/logo(-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.(png|jpg|webp)$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target, metadata)
  values (v_ws, v_uid, 'platform_admin', private.active_grant_id(v_ws),
          'storage.object_' || p_operation, 'workspace-assets/' || p_object_path,
          jsonb_build_object('operation', p_operation, 'bucket_id', 'workspace-assets',
                             'object_path', p_object_path, 'via', 'platform_endpoint', 'outcome', 'requested'))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Append-only TRUNCATE, AAL2 without exceptions, session-bound visibility
-- ---------------------------------------------------------------------------

create trigger activity_events_no_truncate before truncate on public.activity_events
  for each statement execute function private.reject_mutation();
create trigger workspace_audit_log_no_truncate before truncate on public.workspace_audit_log
  for each statement execute function private.reject_mutation();
create trigger platform_audit_log_no_truncate before truncate on public.platform_audit_log
  for each statement execute function private.reject_mutation();

create or replace function private.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     and private.session_is_live();
$$;

create or replace function private.can_see_workspace(p_workspace_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.session_is_live() and (
           exists (
             select 1 from public.workspace_members m
             where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active')
           or private.active_grant_mode(p_workspace_id) is not null);
$$;

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using ((user_id = (select auth.uid()) and (select private.session_is_live()))
         or (private.shares_active_workspace(user_id) and (select private.has_permission('team.read'))));

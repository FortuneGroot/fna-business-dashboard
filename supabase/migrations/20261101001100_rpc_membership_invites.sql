-- M11: request context, workspace switching, invitations, membership changes, soft deletes.
-- All RPCs run with the caller's JWT (SECURITY DEFINER with explicit checks). No service role.
-- Error messages are stable codes: forbidden, not_found, conflict, validation_failed,
-- workspace_suspended, invitation_not_found, invitation_expired, invitation_used,
-- invitation_revoked, invitation_email_mismatch, already_member.

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create function private.require_user()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function private.require_active_workspace()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws uuid := private.active_workspace_id();
begin
  perform private.require_user();
  if v_ws is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_ws;
end;
$$;

create function private.require_permission(p_permission text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.has_permission(p_permission) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create function private.write_audit(p_workspace_id uuid, p_action text, p_target text, p_metadata jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_member boolean := private.active_member_role(p_workspace_id) is not null;
begin
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target, metadata)
  values (
    p_workspace_id,
    auth.uid(),
    case when auth.uid() is null then 'system' when v_member then 'member' else 'platform_admin' end,
    case when v_member then null else private.active_grant_id(p_workspace_id) end,
    p_action,
    p_target,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create function private.invitation_permission(p_role text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_role
    when 'employee' then 'team.invite_employee'
    when 'admin' then 'team.invite_admin'
    when 'owner' then 'team.invite_owner'
  end;
$$;

create function private.hash_token(p_token text)
returns bytea
language sql immutable set search_path = ''
as $$
  select sha256(convert_to(p_token, 'UTF8'));
$$;

-- 64 hex characters from two v4 UUIDs (244 random bits). Uses core functions only.
create function private.new_token()
returns text
language sql volatile set search_path = ''
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Raises if p_user_id is the only active owner of a non-archived workspace. Callers must hold
-- private.lock_workspace_membership(p_workspace_id) so the answer cannot change before they mutate.
create function private.assert_not_last_owner(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
       select 1 from public.workspace_members m
       where m.workspace_id = p_workspace_id and m.user_id = p_user_id
         and m.role = 'owner' and m.status = 'active')
     and not exists (
       select 1 from public.workspace_members m
       where m.workspace_id = p_workspace_id and m.user_id <> p_user_id
         and m.role = 'owner' and m.status = 'active')
     and exists (
       select 1 from public.workspaces w where w.id = p_workspace_id and w.status <> 'archived') then
    raise exception 'a workspace must keep at least one active owner' using errcode = '23514';
  end if;
end;
$$;

-- Unassign a member everywhere and mark the membership removed. Caller has already authorized.
create function private.deactivate_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.opportunities set assigned_user_id = null
    where workspace_id = p_workspace_id and assigned_user_id = p_user_id and status = 'open';
  update public.tasks set assigned_user_id = null
    where workspace_id = p_workspace_id and assigned_user_id = p_user_id and status = 'open';
  update public.conversations set assigned_user_id = null
    where workspace_id = p_workspace_id and assigned_user_id = p_user_id and status = 'open';
  update public.appointments set assigned_user_id = null
    where workspace_id = p_workspace_id and assigned_user_id = p_user_id
      and status in ('booked', 'confirmed');
  update public.contacts set owner_user_id = null
    where workspace_id = p_workspace_id and owner_user_id = p_user_id;
  update public.ai_receptionist_configs set escalation_user_id = null
    where workspace_id = p_workspace_id and escalation_user_id = p_user_id;
  delete from public.calendar_members
    where workspace_id = p_workspace_id and user_id = p_user_id;
  delete from public.member_permission_overrides
    where workspace_id = p_workspace_id and user_id = p_user_id;
  delete from public.user_active_workspace
    where workspace_id = p_workspace_id and user_id = p_user_id;
  update public.workspace_members
    set status = 'removed', removed_at = now(), removed_by = auth.uid()
    where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

-- Audit every data write made under a platform access grant (members are covered by activity logs).
create function private.audit_grant_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_ws uuid := (v_row ->> 'workspace_id')::uuid;
begin
  if auth.uid() is not null
     and private.active_member_role(v_ws) is null
     and private.active_grant_id(v_ws) is not null then
    insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target)
    values (v_ws, auth.uid(), 'platform_admin', private.active_grant_id(v_ws),
            tg_table_name || '.' || lower(tg_op), v_row ->> 'id');
  end if;
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'workspace_settings', 'ai_receptionist_configs', 'integrations', 'contacts', 'contact_tags',
    'contact_notes', 'pipeline_stages', 'opportunities', 'calendars', 'calendar_members',
    'availability_rules', 'appointments', 'conversations', 'messages', 'tasks'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_grant_write()',
      t || '_audit_grant_write', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Request context and workspace switching
-- ---------------------------------------------------------------------------
create function public.request_context()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_selected uuid;
  v_ws uuid;
  v_role text;
  v_grant_id uuid;
  v_ws_json jsonb;
  v_grant_json jsonb;
  v_perms jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('authenticated', false);
  end if;

  select uaw.workspace_id into v_selected from public.user_active_workspace uaw where uaw.user_id = v_uid;
  v_ws := private.active_workspace_id();

  if v_ws is not null then
    v_role := private.active_member_role(v_ws);
    if v_role is null then
      v_grant_id := private.active_grant_id(v_ws);
      select jsonb_build_object('id', g.id, 'mode', g.mode, 'expires_at', g.expires_at)
        into v_grant_json from public.platform_access_grants g where g.id = v_grant_id;
    end if;
    select coalesce(jsonb_agg(p.permission order by p.permission), '[]'::jsonb) into v_perms
    from (
      select permission from public.role_permissions union
      select permission from public.grant_mode_permissions union
      select permission from public.member_permission_overrides where workspace_id = v_ws and user_id = v_uid
    ) p
    where private.has_permission(p.permission);
  elsif v_selected is not null and exists (
      select 1 from public.workspace_members m
      where m.workspace_id = v_selected and m.user_id = v_uid and m.status = 'active') then
    v_ws := v_selected;
  end if;

  if v_ws is not null then
    select jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug, 'status', w.status)
      into v_ws_json from public.workspaces w where w.id = v_ws;
  end if;

  return jsonb_build_object(
    'authenticated', true,
    'user_id', v_uid,
    'is_platform_admin', private.is_platform_admin(),
    'workspace', v_ws_json,
    'role', v_role,
    'grant', v_grant_json,
    'permissions', coalesce(v_perms, '[]'::jsonb)
  );
end;
$$;

create function public.switch_workspace(p_workspace_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if private.active_member_role(p_workspace_id) is null
     and private.active_grant_mode(p_workspace_id) is null then
    if exists (
      select 1 from public.workspace_members m
      join public.workspaces w on w.id = m.workspace_id
      where m.workspace_id = p_workspace_id and m.user_id = v_uid
        and m.status = 'active' and w.status = 'suspended') then
      raise exception 'workspace_suspended' using errcode = 'P0001';
    end if;
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.user_active_workspace (user_id, workspace_id, updated_at)
  values (v_uid, p_workspace_id, now())
  on conflict (user_id) do update set workspace_id = excluded.workspace_id, updated_at = now();

  return public.request_context();
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
create function public.create_invitation(p_email text, p_role text, p_ttl_hours int default 72)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
  v_email text := lower(trim(p_email));
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if p_role is null or p_role not in ('owner', 'admin', 'employee') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform private.require_permission(private.invitation_permission(p_role));

  if exists (
    select 1 from public.workspace_members m
    join auth.users u on u.id = m.user_id
    where m.workspace_id = v_ws and m.status = 'active' and lower(u.email::text) = v_email) then
    raise exception 'already_member' using errcode = '23505';
  end if;

  v_token := private.new_token();
  v_expires := now() + make_interval(hours => p_ttl_hours);

  begin
    insert into public.workspace_invitations (workspace_id, email, role, token_hash, created_by, expires_at)
    values (v_ws, v_email, p_role, private.hash_token(v_token), auth.uid(), v_expires)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;

  perform private.write_audit(v_ws, 'invitation.created', v_id::text,
                              jsonb_build_object('role', p_role, 'email', v_email));

  return jsonb_build_object('invitation_id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

create function public.peek_invitation(p_token text)
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

create function public.accept_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_email text;
  v_inv public.workspace_invitations;
  v_existing public.workspace_members;
begin
  select lower(u.email::text) into v_email from auth.users u where u.id = v_uid;

  -- Workspace lock first (same order as every other membership path), then the invitation row.
  perform private.lock_workspace_membership(i.workspace_id)
  from public.workspace_invitations i where i.token_hash = private.hash_token(p_token);

  select * into v_inv from public.workspace_invitations i
  where i.token_hash = private.hash_token(p_token)
  for update;

  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0001';
  elsif v_inv.revoked_at is not null then
    raise exception 'invitation_revoked' using errcode = 'P0001';
  elsif v_inv.accepted_at is not null then
    raise exception 'invitation_used' using errcode = 'P0001';
  elsif v_inv.expires_at <= now() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  elsif v_email is null or v_email <> lower(v_inv.email::text) then
    raise exception 'invitation_email_mismatch' using errcode = 'P0001';
  elsif not exists (select 1 from public.workspaces w where w.id = v_inv.workspace_id and w.status = 'active') then
    raise exception 'workspace_suspended' using errcode = 'P0001';
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

create function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
  v_inv public.workspace_invitations;
begin
  select * into v_inv from public.workspace_invitations i
  where i.id = p_invitation_id and i.workspace_id = v_ws
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_permission(private.invitation_permission(v_inv.role));
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'conflict' using errcode = '23505';
  end if;
  update public.workspace_invitations set revoked_at = now() where id = v_inv.id;
  perform private.write_audit(v_ws, 'invitation.revoked', v_inv.id::text, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Membership changes (members only; platform grants can never change roles)
-- ---------------------------------------------------------------------------
create function public.set_member_role(p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
  v_target public.workspace_members;
begin
  if private.active_member_role(v_ws) is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.require_permission('team.change_role');
  if p_role is null or p_role not in ('owner', 'admin', 'employee') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  perform private.lock_workspace_membership(v_ws);
  select * into v_target from public.workspace_members m
  where m.workspace_id = v_ws and m.user_id = p_user_id and m.status = 'active'
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_target.role = p_role then
    return;
  end if;
  if p_role <> 'owner' then
    perform private.assert_not_last_owner(v_ws, p_user_id);
  end if;

  if p_role <> 'employee' then
    delete from public.member_permission_overrides where workspace_id = v_ws and user_id = p_user_id;
  end if;
  update public.workspace_members set role = p_role where workspace_id = v_ws and user_id = p_user_id;

  perform private.write_audit(v_ws, 'member.role_changed', p_user_id::text,
                              jsonb_build_object('before', v_target.role, 'after', p_role));
end;
$$;

create function public.set_member_permission(p_user_id uuid, p_permission text, p_allowed boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  if private.active_member_role(v_ws) is null or p_user_id = auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.require_permission('team.manage_overrides');
  if not exists (select 1 from public.role_permissions rp where rp.permission = p_permission) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = v_ws and m.user_id = p_user_id and m.status = 'active') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if p_allowed is null then
    delete from public.member_permission_overrides
      where workspace_id = v_ws and user_id = p_user_id and permission = p_permission;
  else
    insert into public.member_permission_overrides (workspace_id, user_id, permission, allowed)
    values (v_ws, p_user_id, p_permission, p_allowed)
    on conflict (workspace_id, user_id, permission) do update set allowed = excluded.allowed;
  end if;

  perform private.write_audit(v_ws, 'member.permission_override', p_user_id::text,
                              jsonb_build_object('permission', p_permission, 'allowed', p_allowed));
end;
$$;

create function public.remove_member(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
  v_target public.workspace_members;
begin
  if private.active_member_role(v_ws) is null or p_user_id = auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  perform private.lock_workspace_membership(v_ws);
  select * into v_target from public.workspace_members m
  where m.workspace_id = v_ws and m.user_id = p_user_id and m.status = 'active'
  for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if v_target.role in ('owner', 'admin') then
    perform private.require_permission('team.change_role');
  else
    perform private.require_permission('team.remove');
  end if;

  perform private.assert_not_last_owner(v_ws, p_user_id);
  perform private.deactivate_member(v_ws, p_user_id);
  perform private.write_audit(v_ws, 'member.removed', p_user_id::text,
                              jsonb_build_object('role', v_target.role));
end;
$$;

create function public.leave_workspace()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  if private.active_member_role(v_ws) is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform private.lock_workspace_membership(v_ws);
  perform private.assert_not_last_owner(v_ws, auth.uid());
  perform private.write_audit(v_ws, 'member.left', auth.uid()::text, '{}'::jsonb);
  perform private.deactivate_member(v_ws, auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------
-- Soft deletes
-- ---------------------------------------------------------------------------
create function public.soft_delete_contact(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  perform private.require_permission('contacts.delete');
  update public.contacts set deleted_at = now()
    where id = p_id and workspace_id = v_ws and deleted_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.write_audit(v_ws, 'contact.deleted', p_id::text, '{}'::jsonb);
end;
$$;

create function public.soft_delete_opportunity(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  perform private.require_permission('opportunities.delete');
  update public.opportunities set deleted_at = now()
    where id = p_id and workspace_id = v_ws and deleted_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.write_audit(v_ws, 'opportunity.deleted', p_id::text, '{}'::jsonb);
end;
$$;

create function public.soft_delete_task(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  perform private.require_permission('tasks.write');
  update public.tasks set deleted_at = now()
    where id = p_id and workspace_id = v_ws and deleted_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.soft_delete_appointment(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  perform private.require_permission('appointments.write');
  update public.appointments set deleted_at = now()
    where id = p_id and workspace_id = v_ws and deleted_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges
-- ---------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon;

revoke all on function
  public.request_context(),
  public.switch_workspace(uuid),
  public.create_invitation(text, text, int),
  public.peek_invitation(text),
  public.accept_invitation(text),
  public.revoke_invitation(uuid),
  public.set_member_role(uuid, text),
  public.set_member_permission(uuid, text, boolean),
  public.remove_member(uuid),
  public.leave_workspace(),
  public.soft_delete_contact(uuid),
  public.soft_delete_opportunity(uuid),
  public.soft_delete_task(uuid),
  public.soft_delete_appointment(uuid)
from public, anon;

grant execute on function
  public.request_context(),
  public.switch_workspace(uuid),
  public.create_invitation(text, text, int),
  public.peek_invitation(text),
  public.accept_invitation(text),
  public.revoke_invitation(uuid),
  public.set_member_role(uuid, text),
  public.set_member_permission(uuid, text, boolean),
  public.remove_member(uuid),
  public.leave_workspace(),
  public.soft_delete_contact(uuid),
  public.soft_delete_opportunity(uuid),
  public.soft_delete_task(uuid),
  public.soft_delete_appointment(uuid)
to authenticated;

-- The invitation landing page reads basic invitation status before sign-in.
grant execute on function public.peek_invitation(text) to anon;

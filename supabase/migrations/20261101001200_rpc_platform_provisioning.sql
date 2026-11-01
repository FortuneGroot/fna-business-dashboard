-- M12: platform super-admin RPCs: provisioning, suspension, explicit audited access grants.
-- Run with the platform admin's own JWT (AAL2). No service role.

create function private.require_platform_admin()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function private.write_platform_audit(p_action text, p_workspace_id uuid, p_reason text, p_metadata jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.platform_audit_log (actor_id, action, workspace_id, reason, metadata)
  values (auth.uid(), p_action, p_workspace_id, p_reason, coalesce(p_metadata, '{}'::jsonb));
$$;

-- Transactional and idempotent. Seeds configuration and exactly 12 stages; no business records,
-- calendars, or members. The owner joins only by accepting the returned single-use invitation.
create function public.platform_provision_workspace(
  p_provisioning_key text,
  p_name text,
  p_slug text,
  p_owner_email text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_platform_admin();
  v_email text := lower(trim(p_owner_email));
  v_slug text := lower(trim(p_slug));
  v_name text := trim(p_name);
  v_ws public.workspaces;
  v_id uuid;
  v_pipeline uuid;
  v_token text;
  v_invitation uuid;
begin
  if p_provisioning_key is null or v_name is null or v_slug is null or v_email is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  begin
    insert into public.workspaces (slug, name, provisioning_key, bootstrap_owner_email, created_by)
    values (v_slug, v_name, p_provisioning_key, v_email, v_uid)
    on conflict (provisioning_key) do nothing
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'conflict' using errcode = '23505';
    when check_violation then
      raise exception 'validation_failed' using errcode = '22023';
  end;

  if v_id is null then
    select * into v_ws from public.workspaces w where w.provisioning_key = p_provisioning_key;
    if v_ws.name <> v_name or lower(v_ws.slug::text) <> v_slug
       or lower(v_ws.bootstrap_owner_email::text) <> v_email then
      raise exception 'conflict' using errcode = '23505';
    end if;
    select i.id into v_invitation from public.workspace_invitations i
    where i.workspace_id = v_ws.id and i.role = 'owner'
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    order by i.created_at desc limit 1;
    return jsonb_build_object('workspace_id', v_ws.id, 'created', false,
                              'invitation_id', v_invitation, 'invite_token', null);
  end if;

  insert into public.workspace_settings (workspace_id, business_name) values (v_id, v_name);
  insert into public.ai_receptionist_configs (workspace_id) values (v_id);

  insert into public.pipelines (workspace_id, name, is_default)
  values (v_id, 'Sales Pipeline', true)
  returning id into v_pipeline;

  insert into public.pipeline_stages (workspace_id, pipeline_id, name, position, kind)
  select v_id, v_pipeline, s.name, s.position, s.kind
  from (values
    (1,  'New Lead',                 'open'),
    (2,  'Attempting Contact',       'open'),
    (3,  'Connected',                'open'),
    (4,  'Qualified',                'open'),
    (5,  'Appointment Booked',       'open'),
    (6,  'Appointment Completed',    'open'),
    (7,  'Estimate / Proposal Sent', 'open'),
    (8,  'Follow-Up',                'open'),
    (9,  'Decision Pending',         'open'),
    (10, 'Won',                      'won'),
    (11, 'Lost',                     'lost'),
    (12, 'Long-Term Nurture',        'nurture')
  ) as s(position, name, kind);

  v_token := private.new_token();
  insert into public.workspace_invitations (workspace_id, email, role, token_hash, created_by, expires_at)
  values (v_id, v_email, 'owner', private.hash_token(v_token), v_uid, now() + interval '72 hours')
  returning id into v_invitation;

  perform private.write_platform_audit('workspace.provisioned', v_id, null,
    jsonb_build_object('slug', v_slug, 'owner_email', v_email));

  return jsonb_build_object('workspace_id', v_id, 'created', true,
                            'invitation_id', v_invitation, 'invite_token', v_token);
end;
$$;

-- Replaces the bootstrap owner invitation for a workspace that has never had an owner (e.g. the
-- original token was lost or expired). In one transaction: every open owner invitation is revoked
-- and a new one is issued to the provisioned bootstrap_owner_email. Refused forever once any owner
-- has joined (workspaces.owner_acquired_at); after that, owners invite owners.
create function public.platform_rotate_bootstrap_invitation(p_workspace_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_platform_admin();
  v_ws public.workspaces;
  v_revoked uuid[];
  v_token text;
  v_invitation uuid;
  v_expires timestamptz := now() + interval '72 hours';
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  perform private.lock_workspace_membership(p_workspace_id);
  perform private.require_platform_admin();
  select * into v_ws from public.workspaces w where w.id = p_workspace_id;
  if not found or v_ws.status = 'archived' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_ws.status <> 'active' then
    raise exception 'workspace_suspended' using errcode = 'P0001';
  end if;
  if v_ws.owner_acquired_at is not null
     or exists (select 1 from public.workspace_members m
                where m.workspace_id = p_workspace_id and m.role = 'owner') then
    raise exception 'conflict' using errcode = '23505';
  end if;

  with revoked as (
    update public.workspace_invitations i
      set revoked_at = now()
      where i.workspace_id = p_workspace_id and i.role = 'owner'
        and i.accepted_at is null and i.revoked_at is null
      returning i.id
  )
  select coalesce(array_agg(id), '{}') into v_revoked from revoked;

  v_token := private.new_token();
  insert into public.workspace_invitations (workspace_id, email, role, token_hash, created_by, expires_at)
  values (p_workspace_id, v_ws.bootstrap_owner_email, 'owner', private.hash_token(v_token), v_uid, v_expires)
  returning id into v_invitation;

  perform private.write_platform_audit('workspace.bootstrap_invitation_rotated', p_workspace_id, trim(p_reason),
    jsonb_build_object('invitation_id', v_invitation, 'revoked_invitation_ids', to_jsonb(v_revoked)));
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, action, target, metadata)
  values (p_workspace_id, v_uid, 'platform_admin', 'platform.bootstrap_invitation_rotated', v_invitation::text,
          jsonb_build_object('reason', trim(p_reason), 'revoked_invitation_ids', to_jsonb(v_revoked)));

  return jsonb_build_object('workspace_id', p_workspace_id, 'invitation_id', v_invitation,
                            'invite_token', v_token, 'expires_at', v_expires,
                            'revoked_invitation_ids', to_jsonb(v_revoked));
end;
$$;

create function public.platform_suspend_workspace(p_workspace_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.workspaces
    set status = 'suspended', suspended_at = now(), suspended_reason = p_reason
    where id = p_workspace_id and status = 'active';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.write_platform_audit('workspace.suspended', p_workspace_id, p_reason, '{}'::jsonb);
end;
$$;

create function public.platform_reactivate_workspace(p_workspace_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.workspaces
    set status = 'active', suspended_at = null, suspended_reason = null
    where id = p_workspace_id and status = 'suspended';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.write_platform_audit('workspace.reactivated', p_workspace_id, p_reason, '{}'::jsonb);
end;
$$;

create function public.platform_grant_access(
  p_workspace_id uuid,
  p_mode text,
  p_reason text,
  p_minutes int
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_platform_admin();
  v_status text;
  v_grant public.platform_access_grants;
begin
  if p_mode is null or p_mode not in ('read', 'write')
     or p_reason is null or length(trim(p_reason)) < 10
     or p_minutes is null or p_minutes < 1 or p_minutes > 480 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  select w.status into v_status from public.workspaces w where w.id = p_workspace_id;
  if v_status is null or v_status = 'archived' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_status = 'suspended' and p_mode = 'write' then
    raise exception 'workspace_suspended' using errcode = 'P0001';
  end if;

  insert into public.platform_access_grants (workspace_id, admin_user_id, mode, reason, expires_at)
  values (p_workspace_id, v_uid, p_mode, trim(p_reason), now() + make_interval(mins => p_minutes))
  returning * into v_grant;

  insert into public.user_active_workspace (user_id, workspace_id, updated_at)
  values (v_uid, p_workspace_id, now())
  on conflict (user_id) do update set workspace_id = excluded.workspace_id, updated_at = now();

  perform private.write_platform_audit('access.granted', p_workspace_id, v_grant.reason,
    jsonb_build_object('grant_id', v_grant.id, 'mode', v_grant.mode, 'expires_at', v_grant.expires_at));
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, metadata)
  values (p_workspace_id, v_uid, 'platform_admin', v_grant.id, 'platform.access_granted',
          jsonb_build_object('mode', v_grant.mode, 'reason', v_grant.reason, 'expires_at', v_grant.expires_at));

  return jsonb_build_object('id', v_grant.id, 'workspace_id', v_grant.workspace_id,
                            'mode', v_grant.mode, 'expires_at', v_grant.expires_at);
end;
$$;

create function public.platform_revoke_access(p_grant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_grant public.platform_access_grants;
begin
  perform private.require_platform_admin();
  update public.platform_access_grants
    set revoked_at = now(), revoked_by = auth.uid()
    where id = p_grant_id and revoked_at is null
    returning * into v_grant;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.write_platform_audit('access.revoked', v_grant.workspace_id, null,
    jsonb_build_object('grant_id', v_grant.id));
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action)
  values (v_grant.workspace_id, auth.uid(), 'platform_admin', v_grant.id, 'platform.access_revoked');
end;
$$;

create function public.platform_list_workspaces()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'slug', w.slug, 'status', w.status, 'created_at', w.created_at,
      'member_count', (select count(*) from public.workspace_members m
                       where m.workspace_id = w.id and m.status = 'active'))
      order by w.created_at)
    from public.workspaces w), '[]'::jsonb);
end;
$$;

create function public.platform_list_audit(p_workspace_id uuid default null, p_limit int default 100)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(a) order by a.id desc)
    from (
      select * from public.platform_audit_log l
      where p_workspace_id is null or l.workspace_id = p_workspace_id
      order by l.id desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) a), '[]'::jsonb);
end;
$$;

revoke all on all functions in schema private from public, anon;

revoke all on function
  public.platform_provision_workspace(text, text, text, text),
  public.platform_rotate_bootstrap_invitation(uuid, text),
  public.platform_suspend_workspace(uuid, text),
  public.platform_reactivate_workspace(uuid, text),
  public.platform_grant_access(uuid, text, text, int),
  public.platform_revoke_access(uuid),
  public.platform_list_workspaces(),
  public.platform_list_audit(uuid, int)
from public, anon;

grant execute on function
  public.platform_provision_workspace(text, text, text, text),
  public.platform_rotate_bootstrap_invitation(uuid, text),
  public.platform_suspend_workspace(uuid, text),
  public.platform_reactivate_workspace(uuid, text),
  public.platform_grant_access(uuid, text, text, int),
  public.platform_revoke_access(uuid),
  public.platform_list_workspaces(),
  public.platform_list_audit(uuid, int)
to authenticated;

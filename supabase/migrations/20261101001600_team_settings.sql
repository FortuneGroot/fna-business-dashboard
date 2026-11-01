-- M17 (P4): team listing, atomic override changes, the invitation sign-up lookup behind service-role
-- allowlist entry A1, and attribution of configuration changes. Additive only.

-- Active members of the caller's active workspace with their sign-in email (auth.users is not
-- readable by clients) and employee overrides. Requires team.read.
create function public.list_team_members()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws uuid := private.require_active_workspace();
begin
  perform private.require_permission('team.read');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id,
             'name', coalesce(p.full_name, ''),
             'email', u.email::text,
             'role', m.role,
             'status', m.status,
             'joined_at', m.joined_at,
             'overrides', coalesce((
               select jsonb_object_agg(o.permission, o.allowed)
               from public.member_permission_overrides o
               where o.workspace_id = v_ws and o.user_id = m.user_id), '{}'::jsonb))
           order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
                    lower(coalesce(nullif(p.full_name, ''), u.email::text)), m.user_id)
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.user_id = m.user_id
    where m.workspace_id = v_ws and m.status = 'active'), '[]'::jsonb);
end;
$$;

-- Applies several overrides in one transaction ({permission: true | false | null}; null clears).
-- Every entry goes through set_member_permission, so its authorization, locking, validation, and
-- audit apply unchanged; any failure rolls back the whole change.
create function public.set_member_permissions(p_user_id uuid, p_overrides jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
begin
  if p_overrides is null or jsonb_typeof(p_overrides) <> 'object' or p_overrides = '{}'::jsonb
     or (select count(*) from jsonb_object_keys(p_overrides)) > 64 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  for r in select e.key, e.value from jsonb_each(p_overrides) e order by e.key loop
    if jsonb_typeof(r.value) not in ('boolean', 'null') then
      raise exception 'validation_failed' using errcode = '22023';
    end if;
    perform public.set_member_permission(
      p_user_id, r.key,
      case when jsonb_typeof(r.value) = 'null' then null else (r.value #>> '{}')::boolean end);
  end loop;
end;
$$;

-- A1 (service role only): the email of a valid invitation whose address has no account yet, so the
-- server can create that account. The email never comes from the client. Does not consume the
-- invitation; accept_invitation (run with the new user's own JWT) does.
create function public.invitation_signup_email(p_token text)
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
  elsif exists (select 1 from auth.users u where lower(u.email::text) = lower(v_inv.email::text)) then
    raise exception 'conflict' using errcode = '23505';
  end if;
  return lower(v_inv.email::text);
end;
$$;

-- Configuration changes made with a user JWT record which fields changed (never their values) in
-- activity_events, and member changes also in workspace_audit_log (grant writes are already audited
-- by private.audit_grant_write). Trusted server writes without a JWT subject are not attributed.
-- Usage: private.record_config_change('<audit action>').
create function private.record_config_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fields text[];
  v_member boolean;
  v_target text;
begin
  if auth.uid() is null then
    return null;
  end if;
  select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
  from jsonb_each(to_jsonb(new)) n
  where n.key not in ('updated_at', 'updated_by') and n.value is distinct from (to_jsonb(old) -> n.key);
  if cardinality(v_fields) = 0 then
    return null;
  end if;
  v_member := private.active_member_role(new.workspace_id) is not null;
  v_target := case when tg_table_name = 'integrations' then to_jsonb(new) ->> 'id' else tg_table_name end;

  insert into public.activity_events (workspace_id, entity_type, entity_id, action, actor_id, actor_kind, payload)
  values (new.workspace_id, tg_table_name,
          case when tg_table_name = 'integrations' then (to_jsonb(new) ->> 'id')::uuid end,
          'updated', auth.uid(), case when v_member then 'member' else 'platform_admin' end,
          jsonb_build_object('fields', to_jsonb(v_fields)));
  if v_member then
    perform private.write_audit(new.workspace_id, tg_argv[0], v_target, jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;
  return null;
end;
$$;

create trigger workspace_settings_record_change after update on public.workspace_settings
  for each row execute function private.record_config_change('settings.updated');
create trigger ai_receptionist_configs_record_change after update on public.ai_receptionist_configs
  for each row execute function private.record_config_change('ai_receptionist.updated');
create trigger integrations_record_change after update on public.integrations
  for each row execute function private.record_config_change('integration.updated');

revoke all on function private.record_config_change() from public, anon, authenticated;

revoke all on function
  public.list_team_members(),
  public.set_member_permissions(uuid, jsonb),
  public.invitation_signup_email(text)
from public, anon, authenticated;

grant execute on function
  public.list_team_members(),
  public.set_member_permissions(uuid, jsonb)
to authenticated;

grant execute on function public.invitation_signup_email(text) to service_role;

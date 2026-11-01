-- M16 (P2): the signed-in user's workspace list, and the audit RPCs behind the platform Storage
-- endpoint. Both run with the caller's JWT. No service role.

-- Active memberships (any non-archived workspace, with role) plus workspaces reachable through the
-- caller's own live platform access grants (with grant mode).
create function public.list_my_workspaces()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return coalesce((
    select jsonb_agg(s.item order by s.item ->> 'name', s.item ->> 'id')
    from (
      select jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug, 'status', w.status,
                                'role', m.role, 'grant_mode', null) item
      from public.workspace_members m
      join public.workspaces w on w.id = m.workspace_id
      where m.user_id = v_uid and m.status = 'active' and w.status <> 'archived'
      union all
      select jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug, 'status', w.status,
                                'role', null, 'grant_mode', private.active_grant_mode(w.id)) item
      from public.workspaces w
      where w.id in (select g.workspace_id from public.platform_access_grants g
                     where g.admin_user_id = v_uid and g.revoked_at is null and g.expires_at > now())
        and private.active_grant_mode(w.id) is not null
        and not exists (select 1 from public.workspace_members m
                        where m.workspace_id = w.id and m.user_id = v_uid and m.status = 'active')
    ) s), '[]'::jsonb);
end;
$$;

-- Platform Storage changes. Storage write policies are members-only and the Storage API commits
-- rows as service_role without the caller's identity, so a platform admin's logo change goes through
-- /api/platform/workspace-logo: this RPC authorizes and audits the request under the caller's JWT
-- before the server performs the write, and platform_storage_change_finished records the outcome.
create function public.platform_storage_change_requested(p_operation text, p_object_path text)
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
  if p_object_path !~ ('^' || v_ws::text || '/logo\.(png|jpg|webp)$') then
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

-- Records the outcome of a request made by the same platform admin within the last 15 minutes.
-- Does not require the grant to still be live, so a write that completed just before revocation or
-- expiry is still recorded. Each request gets exactly one outcome.
create function public.platform_storage_change_finished(p_request_id bigint, p_succeeded boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := private.require_platform_admin();
  v_req public.workspace_audit_log;
begin
  if p_request_id is null or p_succeeded is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform_storage_change:' || p_request_id::text, 0));
  select * into v_req from public.workspace_audit_log a
  where a.id = p_request_id and a.actor_id = v_uid and a.actor_kind = 'platform_admin'
    and a.metadata ->> 'via' = 'platform_endpoint' and a.metadata ->> 'outcome' = 'requested'
    and a.created_at > now() - interval '15 minutes';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.workspace_audit_log a
             where a.workspace_id = v_req.workspace_id and a.metadata ->> 'request_id' = p_request_id::text) then
    raise exception 'conflict' using errcode = '23505';
  end if;

  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target, metadata)
  values (v_req.workspace_id, v_uid, 'platform_admin', v_req.grant_id, v_req.action, v_req.target,
          (v_req.metadata - 'outcome')
            || jsonb_build_object('outcome', case when p_succeeded then 'succeeded' else 'failed' end,
                                  'request_id', p_request_id::text));
end;
$$;

revoke all on function
  public.list_my_workspaces(),
  public.platform_storage_change_requested(text, text),
  public.platform_storage_change_finished(bigint, boolean)
from public, anon;

grant execute on function
  public.list_my_workspaces(),
  public.platform_storage_change_requested(text, text),
  public.platform_storage_change_finished(bigint, boolean)
to authenticated;

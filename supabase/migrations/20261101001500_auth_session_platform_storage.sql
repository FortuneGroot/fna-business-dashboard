-- M16 (P2): the signed-in user's workspace list, and the audit RPCs behind the platform Storage
-- endpoint. Requests are authorized with the caller's JWT; outcomes are recorded only by the server
-- (service role) and derived from the Storage object itself, never from a caller-supplied flag.

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

-- State of one workspace-assets object (null when absent). `version` exists on the real Storage
-- schema; `updated_at` changes on every Storage update.
create function private.workspace_asset_state(p_object_path text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', o.id, 'updated_at', o.updated_at, 'version', to_jsonb(o) ->> 'version')
  from storage.objects o
  where o.bucket_id = 'workspace-assets' and o.name = p_object_path
$$;
revoke all on function private.workspace_asset_state(text) from public;

-- Platform Storage changes. Storage write policies are members-only and the Storage API commits
-- rows as service_role without the caller's identity, so a platform admin's logo change goes through
-- /api/platform/workspace-logo: this RPC authorizes and audits the request under the caller's JWT
-- (recording the object's state before the change), the server performs the write, and
-- platform_storage_change_finished (service role only) records the outcome.
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
                             'object_path', p_object_path, 'via', 'platform_endpoint', 'outcome', 'requested',
                             'object_before', private.workspace_asset_state(p_object_path)))
  returning id into v_id;
  return v_id;
end;
$$;

-- Requests the server has taken on (claimed immediately before its write). Only claimed requests can
-- receive an outcome, so a request made by calling the RPC directly (no write) never does. At most one
-- unfinished change per object, so outcomes cannot be confused between concurrent server changes.
create table private.platform_storage_changes (
  request_id  bigint primary key references public.workspace_audit_log (id) on delete cascade,
  target      text not null,
  claimed_at  timestamptz not null default now(),
  finished_at timestamptz
);
create unique index platform_storage_changes_one_open
  on private.platform_storage_changes (target) where finished_at is null;
revoke all on private.platform_storage_changes from public;

-- Server-only (service role). Claims a fresh request by `p_actor_id` for execution. Raises
-- 'conflict' while another change to the same object is unfinished (it must be recovered first).
create function public.platform_storage_change_claimed(p_request_id bigint, p_actor_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.workspace_audit_log;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_actor_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select * into v_req from public.workspace_audit_log a
  where a.id = p_request_id and a.actor_id = p_actor_id and a.actor_kind = 'platform_admin'
    and a.metadata ->> 'via' = 'platform_endpoint' and a.metadata ->> 'outcome' = 'requested'
    and a.created_at > now() - interval '5 minutes';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  begin
    insert into private.platform_storage_changes (request_id, target) values (p_request_id, v_req.target);
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
end;
$$;

-- Server-only (service role). Records the outcome of a claimed request by `p_actor_id`, decided from
-- Storage itself: an upsert succeeded if the object now exists and differs from its state at request
-- time; a delete succeeded if the object existed then and is gone now. Idempotent: a retry returns the
-- outcome already recorded, so each request has exactly one outcome. Pending requests stay recoverable
-- (no time limit, no live grant needed).
create function public.platform_storage_change_finished(p_request_id bigint, p_actor_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.workspace_audit_log;
  v_done text;
  v_before jsonb;
  v_after jsonb;
  v_outcome text;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_actor_id is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('platform_storage_change:' || p_request_id::text, 0));
  select a.* into v_req from public.workspace_audit_log a
  join private.platform_storage_changes c on c.request_id = a.id
  where a.id = p_request_id and a.actor_id = p_actor_id and a.actor_kind = 'platform_admin'
    and a.metadata ->> 'via' = 'platform_endpoint' and a.metadata ->> 'outcome' = 'requested';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select a.metadata ->> 'outcome' into v_done from public.workspace_audit_log a
  where a.workspace_id = v_req.workspace_id and a.metadata ->> 'request_id' = p_request_id::text;
  if v_done is not null then
    return v_done;
  end if;

  v_before := nullif(v_req.metadata -> 'object_before', 'null'::jsonb);
  v_after := private.workspace_asset_state(v_req.metadata ->> 'object_path');
  v_outcome := case
    when v_req.metadata ->> 'operation' = 'upsert' and v_after is not null and v_after is distinct from v_before
      then 'succeeded'
    when v_req.metadata ->> 'operation' = 'delete' and v_before is not null and v_after is null
      then 'succeeded'
    else 'failed'
  end;

  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target, metadata)
  values (v_req.workspace_id, v_req.actor_id, 'platform_admin', v_req.grant_id, v_req.action, v_req.target,
          (v_req.metadata - 'outcome' - 'object_before')
            || jsonb_build_object('outcome', v_outcome, 'request_id', p_request_id::text, 'recorded_by', 'server'));
  update private.platform_storage_changes set finished_at = now() where request_id = p_request_id;
  return v_outcome;
end;
$$;

revoke all on function
  public.list_my_workspaces(),
  public.platform_storage_change_requested(text, text),
  public.platform_storage_change_claimed(bigint, uuid),
  public.platform_storage_change_finished(bigint, uuid)
from public, anon, authenticated;

grant execute on function
  public.list_my_workspaces(),
  public.platform_storage_change_requested(text, text)
to authenticated;

grant execute on function
  public.platform_storage_change_claimed(bigint, uuid),
  public.platform_storage_change_finished(bigint, uuid)
to service_role;

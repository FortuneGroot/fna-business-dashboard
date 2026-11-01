-- M16 (P2): the signed-in user's workspace list, and the audit RPCs behind the platform Storage
-- endpoint. Requests are authorized with the caller's JWT; outcomes are recorded only by the server
-- (service role) from evidence of the server's own Storage operation, never from a caller-supplied flag.

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
-- /api/platform/workspace-logo: this RPC authorizes and audits the request under the caller's JWT,
-- the server claims it (receiving a secret operation token), performs the write carrying that token,
-- and platform_storage_change_finished (service role only) records the outcome.
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

-- Server operations on platform Storage requests. The server claims a request immediately before its
-- write and receives a secret token that only it learns. Its write carries the token (upsert: object
-- user metadata; delete: a move of the object to its tombstone path), and the trigger below marks the
-- operation applied in the same transaction that commits it. Only claimed requests can receive an
-- outcome, so a request made by calling the RPC directly never does; at most one unfinished change
-- per object.
create table private.platform_storage_changes (
  request_id  bigint primary key references public.workspace_audit_log (id) on delete cascade,
  operation   text not null check (operation in ('upsert', 'delete')),
  object_path text not null,
  token       uuid not null unique default gen_random_uuid(),
  claimed_at  timestamptz not null default now(),
  applied_at  timestamptz,
  finished_at timestamptz
);
create unique index platform_storage_changes_one_open
  on private.platform_storage_changes (object_path) where finished_at is null;
revoke all on private.platform_storage_changes from public;

-- Where a platform delete moves the object: '<workspace>/.platform-trash/<request id>-<token>.<ext>'.
create function private.platform_storage_tombstone(p_object_path text, p_request_id bigint, p_token uuid)
returns text
language sql immutable set search_path = ''
as $$
  select split_part(p_object_path, '/', 1) || '/.platform-trash/' || p_request_id::text || '-' || p_token::text
         || substring(p_object_path from '\.[a-z]+$')
$$;
revoke all on function private.platform_storage_tombstone(text, bigint, uuid) from public;

-- Marks a claimed server operation applied when its write commits. The Storage API commits every
-- write (a member's or the server's) as service_role without a subject, and an upsert keeps the
-- existing owner, so the session cannot identify the uploader: the operation token does. Only the
-- server knows a claim's token until its own write has committed (it then appears in the object's
-- metadata or tombstone name, when the outcome is already 'succeeded'), so writes without the token —
-- including any member write while the request is pending — are never attributed. A token carried
-- over unchanged from the previous row version is not a new write. A newly written token whose
-- request already has an outcome is refused, so a write still in flight when the outcome was recorded
-- can never take effect afterwards.
create function private.platform_storage_change_applied()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text;
  v_change private.platform_storage_changes;
begin
  if new.bucket_id is distinct from 'workspace-assets' or (select auth.role()) is distinct from 'service_role' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.name is distinct from old.name then
    v_token := substring(new.name from '^[^/]+/\.platform-trash/[0-9]+-([0-9a-f-]{36})\.[a-z]+$');
  elsif tg_op = 'INSERT'
        or (new.version is distinct from old.version
            and new.user_metadata ->> 'platform_operation' is distinct from old.user_metadata ->> 'platform_operation') then
    v_token := new.user_metadata ->> 'platform_operation';
  end if;
  if v_token is null or v_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select * into v_change from private.platform_storage_changes c where c.token = v_token::uuid for update;
  if not found then
    return null;
  end if;
  if v_change.finished_at is not null then
    raise exception 'platform_operation_closed' using errcode = '42501';
  end if;
  if (v_change.operation = 'upsert' and new.name = v_change.object_path
      and (tg_op = 'INSERT' or old.name = new.name))
     or (v_change.operation = 'delete' and tg_op = 'UPDATE' and old.name = v_change.object_path
      and new.name = private.platform_storage_tombstone(v_change.object_path, v_change.request_id, v_change.token)) then
    update private.platform_storage_changes c set applied_at = coalesce(c.applied_at, clock_timestamp())
    where c.request_id = v_change.request_id;
    return null;
  end if;
  raise exception 'platform_operation_mismatch' using errcode = '42501';
end;
$$;
revoke all on function private.platform_storage_change_applied() from public;

create trigger platform_storage_change_applied
  after insert or update on storage.objects
  for each row execute function private.platform_storage_change_applied();

-- Server-only (service role). Claims a fresh request by `p_actor_id` for execution and returns its
-- operation token. Raises 'conflict' while another change to the same object is unfinished.
create function public.platform_storage_change_claimed(p_request_id bigint, p_actor_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.workspace_audit_log;
  v_token uuid;
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
    insert into private.platform_storage_changes (request_id, operation, object_path)
    values (p_request_id, v_req.metadata ->> 'operation', v_req.metadata ->> 'object_path')
    returning token into v_token;
  exception when unique_violation then
    raise exception 'conflict' using errcode = '23505';
  end;
  return v_token;
end;
$$;

-- Server-only (service role). Records the outcome of a claimed request by `p_actor_id`: 'succeeded'
-- exactly when the trigger saw this request's own operation commit, otherwise 'failed'. A member's
-- write to the same object, or any write without this request's token, does not count.
-- `p_operation_returned`: the server's Storage call for this request returned a response. Otherwise
-- (a timeout, a lost response, or a recovery request) the operation may still be running: while it
-- has not been applied and its lease (2 minutes, well above the server's 30 s request timeout) has
-- not expired, nothing is recorded and 'pending' is returned. Recording an outcome closes the token,
-- so from then on the operation can no longer take effect; that is what makes 'failed' final after
-- the lease. Idempotent: a retry returns the outcome already recorded.
create function public.platform_storage_change_finished(p_request_id bigint, p_actor_id uuid, p_operation_returned boolean)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_req public.workspace_audit_log;
  v_change private.platform_storage_changes;
  v_outcome text;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_request_id is null or p_actor_id is null or p_operation_returned is null then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  select c.* into v_change from private.platform_storage_changes c
  join public.workspace_audit_log a on a.id = c.request_id
  where c.request_id = p_request_id and a.actor_id = p_actor_id and a.actor_kind = 'platform_admin'
    and a.metadata ->> 'via' = 'platform_endpoint' and a.metadata ->> 'outcome' = 'requested'
  for update of c;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_req from public.workspace_audit_log a where a.id = p_request_id;
  if v_change.finished_at is not null then
    return (select a.metadata ->> 'outcome' from public.workspace_audit_log a
            where a.workspace_id = v_req.workspace_id and a.metadata ->> 'request_id' = p_request_id::text);
  end if;
  if not p_operation_returned and v_change.applied_at is null
     and v_change.claimed_at > now() - interval '2 minutes' then
    return 'pending';
  end if;

  v_outcome := case when v_change.applied_at is not null then 'succeeded' else 'failed' end;
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, target, metadata)
  values (v_req.workspace_id, v_req.actor_id, 'platform_admin', v_req.grant_id, v_req.action, v_req.target,
          (v_req.metadata - 'outcome')
            || jsonb_build_object('outcome', v_outcome, 'request_id', p_request_id::text, 'recorded_by', 'server',
                                  'resolved_by', case when p_operation_returned then 'operation' else 'recovery' end));
  update private.platform_storage_changes c set finished_at = now() where c.request_id = p_request_id;
  return v_outcome;
end;
$$;

revoke all on function
  public.list_my_workspaces(),
  public.platform_storage_change_requested(text, text),
  public.platform_storage_change_claimed(bigint, uuid),
  public.platform_storage_change_finished(bigint, uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.list_my_workspaces(),
  public.platform_storage_change_requested(text, text)
to authenticated;

grant execute on function
  public.platform_storage_change_claimed(bigint, uuid),
  public.platform_storage_change_finished(bigint, uuid, boolean)
to service_role;

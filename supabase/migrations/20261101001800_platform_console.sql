-- M19 (P6): platform console. Read RPCs for the console (workspace search and detail, access grants,
-- paged audit), the caller's own platform status (so an AAL1 session can be sent to MFA), and grant
-- revocation with a required reason. Every RPC runs under the platform admin's own JWT and requires
-- private.is_platform_admin() (AAL2). No business records are readable here: tenant data still needs
-- an explicit access grant. Additive, except that the reason-less platform_revoke_access(uuid) is no
-- longer executable by clients.

-- The caller's own status: whether they are listed as a platform admin, their session's assurance
-- level, and whether platform authority is active (listed and AAL2). Reveals nothing about others.
create function public.platform_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'listed', exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'active', private.is_platform_admin());
$$;

-- Escapes LIKE wildcards so a search term matches literally.
create function private.like_pattern(p_term text)
returns text
language sql immutable set search_path = ''
as $$
  select '%' || replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
$$;

-- Workspaces matching an optional name/slug/owner-email search and status, newest first, with an
-- exact total. Keyset paging on (created_at, id).
create function public.platform_search_workspaces(
  p_query text default null,
  p_status text default null,
  p_limit int default 25,
  p_after_created timestamptz default null,
  p_after_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_q text := nullif(trim(coalesce(p_query, '')), '');
  v_pattern text;
  v_limit int := coalesce(p_limit, 25);
  v_items jsonb;
  v_total bigint;
begin
  perform private.require_platform_admin();
  if (p_status is not null and p_status not in ('active', 'suspended', 'archived'))
     or (v_q is not null and length(v_q) > 100)
     or v_limit < 1 or v_limit > 101
     or ((p_after_created is null) <> (p_after_id is null)) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  v_pattern := private.like_pattern(v_q);

  select count(*) into v_total
  from public.workspaces w
  where (p_status is null or w.status = p_status)
    and (v_q is null or w.name ilike v_pattern or w.slug::text ilike v_pattern
         or w.bootstrap_owner_email::text ilike v_pattern);

  select coalesce(jsonb_agg(s.item order by s.created_at desc, s.id desc), '[]'::jsonb) into v_items
  from (
    select w.created_at, w.id, jsonb_build_object(
      'id', w.id, 'name', w.name, 'slug', w.slug, 'status', w.status, 'created_at', w.created_at,
      'member_count', (select count(*) from public.workspace_members m
                       where m.workspace_id = w.id and m.status = 'active'),
      'owner_joined', w.owner_acquired_at is not null) item
    from public.workspaces w
    where (p_status is null or w.status = p_status)
      and (v_q is null or w.name ilike v_pattern or w.slug::text ilike v_pattern
           or w.bootstrap_owner_email::text ilike v_pattern)
      and (p_after_created is null or (w.created_at, w.id) < (p_after_created, p_after_id))
    order by w.created_at desc, w.id desc
    limit v_limit
  ) s;

  return jsonb_build_object('items', v_items, 'total', v_total);
end;
$$;

-- One workspace for the console: identity, status, membership counts, and whether a bootstrap owner
-- invitation is open (its id and expiry only; never a token or hash).
create function public.platform_get_workspace(p_workspace_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws public.workspaces;
  v_has_owner boolean;
begin
  perform private.require_platform_admin();
  select * into v_ws from public.workspaces w where w.id = p_workspace_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = v_ws.id and m.role = 'owner') into v_has_owner;

  return jsonb_build_object(
    'id', v_ws.id, 'name', v_ws.name, 'slug', v_ws.slug, 'status', v_ws.status,
    'created_at', v_ws.created_at, 'suspended_at', v_ws.suspended_at,
    'suspended_reason', v_ws.suspended_reason, 'bootstrap_owner_email', v_ws.bootstrap_owner_email,
    'owner_acquired_at', v_ws.owner_acquired_at,
    'members', (select jsonb_build_object(
                  'owner', count(*) filter (where m.role = 'owner'),
                  'admin', count(*) filter (where m.role = 'admin'),
                  'employee', count(*) filter (where m.role = 'employee'))
                from public.workspace_members m
                where m.workspace_id = v_ws.id and m.status = 'active'),
    'open_owner_invitation', (select jsonb_build_object('id', i.id, 'created_at', i.created_at, 'expires_at', i.expires_at)
                              from public.workspace_invitations i
                              where i.workspace_id = v_ws.id and i.role = 'owner'
                                and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
                              order by i.created_at desc limit 1),
    'can_rotate_bootstrap', v_ws.status = 'active' and v_ws.owner_acquired_at is null and not v_has_owner);
end;
$$;

-- Access grants, newest first: all platform admins' grants (optionally for one workspace, optionally
-- only live ones). `mine` marks the caller's own.
create function public.platform_list_grants(
  p_workspace_id uuid default null,
  p_active_only boolean default true,
  p_limit int default 50
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(s.item order by s.created_at desc, s.id desc)
    from (
      select g.created_at, g.id, jsonb_build_object(
        'id', g.id, 'workspace_id', g.workspace_id, 'workspace_name', w.name, 'workspace_status', w.status,
        'admin_user_id', g.admin_user_id, 'admin_email', u.email, 'mode', g.mode, 'reason', g.reason,
        'created_at', g.created_at, 'expires_at', g.expires_at, 'revoked_at', g.revoked_at,
        'active', g.revoked_at is null and g.expires_at > now(),
        'mine', g.admin_user_id = auth.uid()) item
      from public.platform_access_grants g
      join public.workspaces w on w.id = g.workspace_id
      left join auth.users u on u.id = g.admin_user_id
      where (p_workspace_id is null or g.workspace_id = p_workspace_id)
        and (not coalesce(p_active_only, true) or (g.revoked_at is null and g.expires_at > now()))
      order by g.created_at desc, g.id desc
      limit p_limit
    ) s), '[]'::jsonb);
end;
$$;

-- Ends a live grant with a reason (at least 10 characters), recorded in both audit logs. Revoked or
-- expired grants are not_found, so the audit never records ending access that had already ended.
create function public.platform_revoke_access(p_grant_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_grant public.platform_access_grants;
begin
  perform private.require_platform_admin();
  if p_reason is null or length(trim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  update public.platform_access_grants
    set revoked_at = now(), revoked_by = auth.uid()
    where id = p_grant_id and revoked_at is null and expires_at > now()
    returning * into v_grant;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.write_platform_audit('access.revoked', v_grant.workspace_id, trim(p_reason),
    jsonb_build_object('grant_id', v_grant.id, 'mode', v_grant.mode));
  insert into public.workspace_audit_log (workspace_id, actor_id, actor_kind, grant_id, action, metadata)
  values (v_grant.workspace_id, auth.uid(), 'platform_admin', v_grant.id, 'platform.access_revoked',
          jsonb_build_object('reason', trim(p_reason)));
end;
$$;

-- Platform audit entries, newest first, with the actor's email and the workspace name. Keyset paging
-- on id (p_before_id).
create function public.platform_audit_page(
  p_workspace_id uuid default null,
  p_before_id bigint default null,
  p_limit int default 50
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  if p_limit is null or p_limit < 1 or p_limit > 101 then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(s.item order by s.id desc)
    from (
      select l.id, jsonb_build_object(
        'id', l.id, 'created_at', l.created_at, 'action', l.action, 'reason', l.reason,
        'metadata', l.metadata, 'workspace_id', l.workspace_id, 'workspace_name', w.name,
        'actor_id', l.actor_id, 'actor_email', u.email) item
      from public.platform_audit_log l
      left join public.workspaces w on w.id = l.workspace_id
      left join auth.users u on u.id = l.actor_id
      where (p_workspace_id is null or l.workspace_id = p_workspace_id)
        and (p_before_id is null or l.id < p_before_id)
      order by l.id desc
      limit p_limit
    ) s), '[]'::jsonb);
end;
$$;

revoke all on function private.like_pattern(text) from public, anon;

revoke all on function
  public.platform_status(),
  public.platform_search_workspaces(text, text, int, timestamptz, uuid),
  public.platform_get_workspace(uuid),
  public.platform_list_grants(uuid, boolean, int),
  public.platform_revoke_access(uuid, text),
  public.platform_audit_page(uuid, bigint, int)
from public, anon;

grant execute on function
  public.platform_status(),
  public.platform_search_workspaces(text, text, int, timestamptz, uuid),
  public.platform_get_workspace(uuid),
  public.platform_list_grants(uuid, boolean, int),
  public.platform_revoke_access(uuid, text),
  public.platform_audit_page(uuid, bigint, int)
to authenticated;

-- Revocation always carries a reason now.
revoke execute on function public.platform_revoke_access(uuid) from authenticated;

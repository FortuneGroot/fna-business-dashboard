-- M4: authorization helpers used by RLS policies, triggers, and RPCs.
-- All are SECURITY DEFINER with an empty search_path and fully qualified names.
-- Emails are compared with lower(...::text) because citext operators are not on the empty search_path.

create function private.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())
     and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
          or coalesce(current_setting('app.platform_allow_aal1', true), '') = 'on');
$$;

-- Role of the caller in a workspace, only if the membership is active and the workspace is active.
create function private.active_member_role(p_workspace_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select m.role
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.workspace_id = p_workspace_id
    and m.user_id = auth.uid()
    and m.status = 'active'
    and w.status = 'active';
$$;

-- Mode of the caller's live platform access grant for a workspace ('write' preferred), or null.
-- Suspended workspaces honour read grants only.
create function private.active_grant_mode(p_workspace_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select g.mode
  from public.platform_access_grants g
  join public.workspaces w on w.id = g.workspace_id
  where g.workspace_id = p_workspace_id
    and g.admin_user_id = auth.uid()
    and g.revoked_at is null
    and g.expires_at > now()
    and w.status <> 'archived'
    and (w.status = 'active' or g.mode = 'read')
    and private.is_platform_admin()
  order by (g.mode = 'write') desc, g.expires_at desc
  limit 1;
$$;

create function private.active_grant_id(p_workspace_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select g.id
  from public.platform_access_grants g
  join public.workspaces w on w.id = g.workspace_id
  where g.workspace_id = p_workspace_id
    and g.admin_user_id = auth.uid()
    and g.revoked_at is null
    and g.expires_at > now()
    and w.status <> 'archived'
    and (w.status = 'active' or g.mode = 'read')
    and private.is_platform_admin()
  order by (g.mode = 'write') desc, g.expires_at desc
  limit 1;
$$;

-- The caller's validated active workspace. Re-evaluated on every statement, so removal,
-- suspension, grant expiry, and grant revocation take effect immediately.
create function private.active_workspace_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select uaw.workspace_id
  from public.user_active_workspace uaw
  where uaw.user_id = auth.uid()
    and (private.active_member_role(uaw.workspace_id) is not null
         or private.active_grant_mode(uaw.workspace_id) is not null);
$$;

-- Permission check in the caller's active workspace.
-- Members: role permissions adjusted by per-member overrides. Members take precedence over grants.
create function private.has_permission(p_permission text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws uuid := private.active_workspace_id();
  v_role text;
  v_mode text;
  v_override boolean;
begin
  if v_ws is null then
    return false;
  end if;

  v_role := private.active_member_role(v_ws);
  if v_role is not null then
    select o.allowed into v_override
    from public.member_permission_overrides o
    where o.workspace_id = v_ws and o.user_id = auth.uid() and o.permission = p_permission;
    if v_override is not null then
      return v_override;
    end if;
    return exists (
      select 1 from public.role_permissions rp
      where rp.role = v_role and rp.permission = p_permission
    );
  end if;

  v_mode := private.active_grant_mode(v_ws);
  return v_mode is not null and exists (
    select 1 from public.grant_mode_permissions gp
    where gp.mode = v_mode and gp.permission = p_permission
  );
end;
$$;

-- Workspaces the caller may see the name/status of (active or removed-not; suspended included).
create function private.can_see_workspace(p_workspace_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
           select 1 from public.workspace_members m
           where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active')
      or private.active_grant_mode(p_workspace_id) is not null;
$$;

-- Users who share the caller's active workspace (for profile visibility).
create function private.shares_active_workspace(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = private.active_workspace_id()
      and m.user_id = p_user_id
  );
$$;

-- ---------------------------------------------------------------------------
-- Generic trigger functions
-- ---------------------------------------------------------------------------

create function private.forbid_workspace_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Usage: execute function private.assert_active_member('assigned_user_id', 'owner_user_id', ...)
-- Rejects newly set user references that are not active members of the row's workspace.
create function private.assert_active_member()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_col text;
  v_new uuid;
  v_old uuid;
begin
  foreach v_col in array tg_argv loop
    v_new := (to_jsonb(new) ->> v_col)::uuid;
    if v_new is null then
      continue;
    end if;
    if tg_op = 'UPDATE' then
      v_old := (to_jsonb(old) ->> v_col)::uuid;
      if v_old is not distinct from v_new then
        continue;
      end if;
    end if;
    if not exists (
      select 1 from public.workspace_members m
      where m.workspace_id = new.workspace_id and m.user_id = v_new and m.status = 'active'
    ) then
      raise exception '% must reference an active member of the same workspace', v_col
        using errcode = '23503';
    end if;
  end loop;
  return new;
end;
$$;

create function private.set_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function private.reject_mutation()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.is_platform_admin(),
  private.active_member_role(uuid),
  private.active_grant_mode(uuid),
  private.active_grant_id(uuid),
  private.active_workspace_id(),
  private.has_permission(text),
  private.can_see_workspace(uuid),
  private.shares_active_workspace(uuid)
to authenticated;

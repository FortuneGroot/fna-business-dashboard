-- M21: logout ends access immediately (spec §5.1 decision; Codex recommendation before real use).
-- Until now a copied access token of a logged-out session kept working for reads and ordinary
-- writes until it expired, because JWT verification does not consult the session. Supabase Auth
-- deletes the session row on logout (and on refresh-token revocation, password change, admin
-- sign-out); every access token names its session in the `session_id` claim. Access now requires
-- that row to still exist:
--   * private.active_workspace_id() and private.is_platform_admin() — every workspace RLS policy,
--     permission check, workspace RPC, Storage policy, and platform RPC goes through one of them;
--   * request_context() reports a dead session as signed out, so the app answers 401 / login;
--   * a PostgREST pre-request check refuses any API request carrying a dead session with 401
--     (also covers own-profile reads and the user-level RPCs that need no workspace).
-- Tokens without a `session_id` claim are not session-bound: Supabase Auth issues none for user
-- sessions, so only a holder of the signing secret can produce one, which is not a replay path.

create function private.session_is_live()
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_sid text := auth.jwt() ->> 'session_id';
begin
  if v_sid is null or v_sid = '' then
    return true;
  end if;
  return exists (
    select 1 from auth.sessions s
    where s.id = v_sid::uuid
      and s.user_id = auth.uid()
      and (s.not_after is null or s.not_after > now())
  );
exception when invalid_text_representation then
  return false;
end;
$$;

create or replace function private.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())
     and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
          or coalesce(current_setting('app.platform_allow_aal1', true), '') = 'on')
     and private.session_is_live();
$$;

create or replace function private.active_workspace_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select uaw.workspace_id
  from public.user_active_workspace uaw
  where uaw.user_id = auth.uid()
    and private.session_is_live()
    and (private.active_member_role(uaw.workspace_id) is not null
         or private.active_grant_mode(uaw.workspace_id) is not null);
$$;

create or replace function public.request_context()
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
  if v_uid is null or not private.session_is_live() then
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

-- PostgREST pre-request check (runs before every API request, for every role). SQLSTATE PT401
-- makes PostgREST answer HTTP 401.
create function public.check_request_session()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.session_is_live() then
    raise sqlstate 'PT401' using message = 'session_ended', detail = 'This session has ended. Sign in again.';
  end if;
end;
$$;

revoke all on function private.session_is_live() from public, anon, authenticated;
grant execute on function private.session_is_live() to authenticated;
revoke all on function public.check_request_session() from public;
grant execute on function public.check_request_session() to anon, authenticated, service_role;

-- Registered only where PostgREST's own role exists (Supabase); plain test databases have none.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.check_request_session''';
    notify pgrst, 'reload config';
  end if;
end;
$$;

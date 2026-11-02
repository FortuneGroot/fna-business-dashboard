-- M24: an open invitation never outlives its creator's authority to issue it.
--
-- accept_invitation checks the token, expiry, email and workspace, but authority was only checked
-- when the invitation was created. An owner who invited a second address of their own could be
-- removed or demoted and then accept that invitation to return as owner. Removing a member (or a
-- member leaving) now revokes every open invitation they created in that workspace; a role change
-- revokes the ones the new role could not issue. Each revocation is audited, in the same
-- transaction as the membership change. Bootstrap invitations (created by a platform admin, who is
-- not a member) are unaffected.

create function private.revoke_invitations_beyond(p_workspace_id uuid, p_user_id uuid, p_role text, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  for v_id in
    update public.workspace_invitations i
      set revoked_at = now()
      where i.workspace_id = p_workspace_id
        and i.created_by = p_user_id
        and i.accepted_at is null
        and i.revoked_at is null
        and (p_role is null or not exists (
          select 1 from public.role_permissions rp
          where rp.role = p_role and rp.permission = private.invitation_permission(i.role)))
      returning i.id
  loop
    perform private.write_audit(p_workspace_id, 'invitation.revoked', v_id::text,
                                jsonb_build_object('reason', p_reason));
  end loop;
end;
$$;

revoke all on function private.revoke_invitations_beyond(uuid, uuid, text, text) from public, anon, authenticated;

-- Same as M11, plus the revocation before the membership is marked removed (so a member who leaves
-- is still attributed as a member in the audit rows).
create or replace function private.deactivate_member(p_workspace_id uuid, p_user_id uuid)
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
  perform private.revoke_invitations_beyond(p_workspace_id, p_user_id, null, 'inviter_removed');
  update public.workspace_members
    set status = 'removed', removed_at = now(), removed_by = auth.uid()
    where workspace_id = p_workspace_id and user_id = p_user_id;
end;
$$;

-- Same as M11, plus the revocation of invitations the new role could not issue.
create or replace function public.set_member_role(p_user_id uuid, p_role text)
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
  perform private.recheck_authority(v_ws, 'team.change_role', true);
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
  perform private.revoke_invitations_beyond(v_ws, p_user_id, p_role, 'inviter_role_changed');

  perform private.write_audit(v_ws, 'member.role_changed', p_user_id::text,
                              jsonb_build_object('before', v_target.role, 'after', p_role));
end;
$$;

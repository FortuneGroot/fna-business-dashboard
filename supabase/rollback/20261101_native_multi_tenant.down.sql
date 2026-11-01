-- Rollback for migrations 20261101000100 … 20261101001300 and 20261101001500 (native multi-tenant).
-- LOCAL / STAGING ONLY. Never run against production; production rolls back by app flag.
-- Leaves legacy tables (auth_sessions, sync_*) untouched. Destroys all native tenant data.
-- 20261101001400_legacy_lockdown is intentionally NOT reverted: re-granting anon/authenticated
-- access to legacy tables would reopen them to the public Data API.

begin;

-- M16 (P2)
drop function if exists public.list_my_workspaces();
drop function if exists public.platform_storage_change_requested(text, text);
drop function if exists public.platform_storage_change_finished(bigint, uuid, boolean);
drop function if exists public.platform_storage_change_claimed(bigint, uuid);
drop trigger if exists platform_storage_change_applied on storage.objects;
drop function if exists private.platform_storage_change_applied();
drop function if exists private.platform_storage_tombstone(text, bigint, uuid);
drop table if exists private.platform_storage_changes;

-- M13
do $$
begin
  if to_regclass('storage.objects') is not null then
    drop trigger if exists workspace_assets_audit_grant_write on storage.objects;
    drop policy if exists workspace_assets_read on storage.objects;
    drop policy if exists workspace_assets_insert on storage.objects;
    drop policy if exists workspace_assets_update on storage.objects;
    drop policy if exists workspace_assets_delete on storage.objects;
    delete from storage.buckets where id = 'workspace-assets';
  end if;
end;
$$;
drop view if exists public.pipeline_stage_summary;

-- M12, M11 (public RPCs)
drop function if exists public.platform_provision_workspace(text, text, text, text);
drop function if exists public.platform_rotate_bootstrap_invitation(uuid, text);
drop function if exists public.platform_suspend_workspace(uuid, text);
drop function if exists public.platform_reactivate_workspace(uuid, text);
drop function if exists public.platform_grant_access(uuid, text, text, int);
drop function if exists public.platform_revoke_access(uuid);
drop function if exists public.platform_list_workspaces();
drop function if exists public.platform_list_audit(uuid, int);
drop function if exists public.request_context();
drop function if exists public.switch_workspace(uuid);
drop function if exists public.create_invitation(text, text, int);
drop function if exists public.peek_invitation(text);
drop function if exists public.accept_invitation(text);
drop function if exists public.revoke_invitation(uuid);
drop function if exists public.set_member_role(uuid, text);
drop function if exists public.set_member_permission(uuid, text, boolean);
drop function if exists public.remove_member(uuid);
drop function if exists public.leave_workspace();
drop function if exists public.soft_delete_contact(uuid);
drop function if exists public.soft_delete_opportunity(uuid);
drop function if exists public.soft_delete_task(uuid);
drop function if exists public.soft_delete_appointment(uuid);

-- M9 trigger on auth.users
drop trigger if exists on_auth_user_created_profile on auth.users;

-- M8 … M2 tables (reverse dependency order); policies and triggers drop with them.
drop table if exists public.workspace_audit_log;
drop table if exists public.activity_events;
drop table if exists public.reviews;
drop table if exists public.tasks;
drop table if exists public.messages;
drop table if exists public.conversations;
drop table if exists public.appointments;
drop table if exists public.availability_rules;
drop table if exists public.calendar_members;
drop table if exists public.calendars;
drop table if exists public.opportunities;
drop table if exists public.pipeline_stages;
drop table if exists public.pipelines;
drop table if exists public.contact_notes;
drop table if exists public.contact_tags;
drop table if exists public.contacts;
drop table if exists public.integration_secrets;
drop table if exists public.integrations;
drop table if exists public.ai_receptionist_configs;
drop table if exists public.workspace_settings;
drop table if exists public.platform_access_grants;
drop table if exists public.workspace_invitations;
drop table if exists public.user_active_workspace;
drop table if exists public.member_permission_overrides;
drop table if exists public.workspace_members;
drop table if exists public.platform_audit_log;
drop table if exists public.grant_mode_permissions;
drop table if exists public.role_permissions;
drop table if exists public.workspaces;
drop table if exists public.platform_admins;
drop table if exists public.profiles;

-- M4 / M1 helpers. Extensions are left installed (other objects may depend on them).
drop schema if exists private cascade;

commit;

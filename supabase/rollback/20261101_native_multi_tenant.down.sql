-- Rollback for migrations 20261101000100 … 20261101001300 and 20261101001500 … 20261101002200 (native multi-tenant).
-- LOCAL / STAGING ONLY. Never run against production; production rolls back by app flag.
-- Leaves legacy tables (auth_sessions, sync_*) untouched. Destroys all native tenant data.
-- 20261101001400_legacy_lockdown is intentionally NOT reverted: re-granting anon/authenticated
-- access to legacy tables would reopen them to the public Data API.

begin;

-- M23 (per-calendar booking lock)
drop trigger if exists appointments_lock_calendar on public.appointments;
drop function if exists private.lock_appointment_calendars();

-- M22 (platform-admin guard)
drop trigger if exists platform_admins_no_truncate on public.platform_admins;
drop trigger if exists platform_admins_keep_one on public.platform_admins;
drop trigger if exists platform_admins_serialize on public.platform_admins;
drop function if exists public.platform_admin_revoke(uuid, text, jsonb);
drop function if exists public.platform_admin_grant(uuid, jsonb);
drop function if exists private.platform_admins_no_truncate();
drop function if exists private.platform_admins_keep_one();
drop function if exists private.platform_admins_serialize();
drop function if exists private.lock_platform_admins();

-- M21 (session revocation); M20 only replaced replace_availability, dropped under M18.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator reset pgrst.db_pre_request';
    notify pgrst, 'reload config';
  end if;
end $$;
drop function if exists public.check_request_session();
drop function if exists private.session_is_live();

-- M19 (P6)
drop function if exists public.platform_audit_page(uuid, bigint, int);
drop function if exists public.platform_revoke_access(uuid, text);
drop function if exists public.platform_list_grants(uuid, boolean, int);
drop function if exists public.platform_get_workspace(uuid);
drop function if exists public.platform_search_workspaces(text, text, int, timestamptz, uuid);
drop function if exists private.like_pattern(text);
drop function if exists public.platform_status();
do $$
begin
  if to_regprocedure('public.platform_revoke_access(uuid)') is not null then
    grant execute on function public.platform_revoke_access(uuid) to authenticated;
  end if;
end $$;

-- M18 (P5)
drop trigger if exists contacts_record_activity on public.contacts;
drop trigger if exists contact_notes_record_activity on public.contact_notes;
drop trigger if exists opportunities_record_activity on public.opportunities;
drop trigger if exists calendars_record_activity on public.calendars;
drop trigger if exists appointments_record_activity on public.appointments;
drop trigger if exists tasks_record_activity on public.tasks;
drop trigger if exists messages_record_activity on public.messages;
drop function if exists private.record_crm_activity();
drop function if exists public.save_contact(uuid, jsonb, text[]);
drop function if exists public.save_calendar(uuid, jsonb, uuid[]);
drop function if exists public.replace_availability(uuid, jsonb);

-- M17 (P4)
drop trigger if exists workspace_settings_record_change on public.workspace_settings;
drop trigger if exists ai_receptionist_configs_record_change on public.ai_receptionist_configs;
drop trigger if exists integrations_record_change on public.integrations;
drop function if exists private.record_config_change();
drop function if exists public.list_team_members();
drop function if exists public.set_member_permissions(uuid, jsonb);
drop function if exists public.invitation_signup_email(text);

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

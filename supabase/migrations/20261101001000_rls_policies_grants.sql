-- M10: Row Level Security and explicit grants.
-- Supabase grants ALL on new public tables to anon/authenticated by default; this migration
-- revokes that and grants only what each policy needs. anon gets nothing.

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'platform_admins', 'workspaces', 'role_permissions', 'grant_mode_permissions',
    'platform_audit_log', 'workspace_members', 'member_permission_overrides',
    'user_active_workspace', 'workspace_invitations', 'platform_access_grants',
    'workspace_settings', 'ai_receptionist_configs', 'integrations', 'integration_secrets',
    'contacts', 'contact_tags', 'contact_notes', 'pipelines', 'pipeline_stages', 'opportunities',
    'calendars', 'calendar_members', 'availability_rules', 'appointments', 'conversations',
    'messages', 'tasks', 'reviews', 'activity_events', 'workspace_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end;
$$;

-- No grants and no policies (RPC / service-role only):
--   platform_admins, platform_audit_log, platform_access_grants, integration_secrets

-- ---------------------------------------------------------------------------
-- Global reference and identity
-- ---------------------------------------------------------------------------
grant select on public.role_permissions, public.grant_mode_permissions to authenticated;
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
create policy grant_mode_permissions_read on public.grant_mode_permissions for select to authenticated using (true);

grant select (user_id, full_name, avatar_path, created_at, updated_at) on public.profiles to authenticated;
grant update (full_name, avatar_path) on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid())
         or (private.shares_active_workspace(user_id) and (select private.has_permission('team.read'))));
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select (id, slug, name, status) on public.workspaces to authenticated;
create policy workspaces_select on public.workspaces for select to authenticated
  using (private.can_see_workspace(id));

-- ---------------------------------------------------------------------------
-- Membership (read-only through the API; changes go through RPCs)
-- ---------------------------------------------------------------------------
grant select on public.workspace_members to authenticated;
create policy workspace_members_select on public.workspace_members for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('team.read')));

grant select on public.member_permission_overrides to authenticated;
create policy member_permission_overrides_select on public.member_permission_overrides for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('team.read')));

grant select on public.user_active_workspace to authenticated;
create policy user_active_workspace_select_own on public.user_active_workspace for select to authenticated
  using (user_id = (select auth.uid()));

grant select (id, workspace_id, email, role, created_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)
  on public.workspace_invitations to authenticated;
create policy workspace_invitations_select on public.workspace_invitations for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('team.read')));

-- ---------------------------------------------------------------------------
-- Workspace configuration
-- ---------------------------------------------------------------------------
grant select on public.workspace_settings to authenticated;
grant update (business_name, legal_name, timezone, industry, support_email, business_phone,
              website_url, booking_url, review_url, brand_colors, logo_path, business_hours)
  on public.workspace_settings to authenticated;
create policy workspace_settings_select on public.workspace_settings for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('settings.read')));
create policy workspace_settings_update on public.workspace_settings for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('settings.write')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('settings.write')));

grant select on public.ai_receptionist_configs to authenticated;
-- No grant on "enabled": enablement waits for trusted provider verification and a runtime.
grant update (greeting, business_hours_mode, escalation_user_id, faq, voice)
  on public.ai_receptionist_configs to authenticated;
create policy ai_receptionist_select on public.ai_receptionist_configs for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('ai_receptionist.read')));
create policy ai_receptionist_update on public.ai_receptionist_configs for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('ai_receptionist.write')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('ai_receptionist.write')));

grant select on public.integrations to authenticated;
-- status, capabilities, verified_at, and connected_by are server-controlled (no client grant).
grant insert (workspace_id, provider, config) on public.integrations to authenticated;
grant update (config) on public.integrations to authenticated;
create policy integrations_select on public.integrations for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('integrations.read')));
create policy integrations_insert on public.integrations for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('integrations.manage'))
              and connected_by = (select auth.uid())
              and status = 'disconnected' and verified_at is null);
create policy integrations_update on public.integrations for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('integrations.manage')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('integrations.manage')));

-- ---------------------------------------------------------------------------
-- CRM core
-- ---------------------------------------------------------------------------
grant select on public.contacts to authenticated;
-- created_by / author columns are stamped by triggers and are deliberately not grantable.
grant insert (workspace_id, first_name, last_name, email, phone, source, owner_user_id, dnd)
  on public.contacts to authenticated;
grant update (first_name, last_name, email, phone, source, owner_user_id, dnd)
  on public.contacts to authenticated;
create policy contacts_select on public.contacts for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('contacts.read'))
         and (deleted_at is null or (select private.has_permission('contacts.delete'))));
create policy contacts_insert on public.contacts for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('contacts.write'))
              and created_by = (select auth.uid()));
create policy contacts_update on public.contacts for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('contacts.write'))
         and deleted_at is null)
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('contacts.write')));

grant select, insert, delete on public.contact_tags to authenticated;
create policy contact_tags_select on public.contact_tags for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('contacts.read')));
create policy contact_tags_insert on public.contact_tags for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('contacts.write')));
create policy contact_tags_delete on public.contact_tags for delete to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('contacts.write')));

grant select on public.contact_notes to authenticated;
grant insert (workspace_id, contact_id, body) on public.contact_notes to authenticated;
create policy contact_notes_select on public.contact_notes for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('contacts.read')));
create policy contact_notes_insert on public.contact_notes for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('contacts.write'))
              and author_id = (select auth.uid()));

grant select on public.pipelines to authenticated;
create policy pipelines_select on public.pipelines for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('pipeline.read')));

grant select on public.pipeline_stages to authenticated;
grant update (name) on public.pipeline_stages to authenticated;
create policy pipeline_stages_select on public.pipeline_stages for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('pipeline.read')));
create policy pipeline_stages_update on public.pipeline_stages for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('pipeline.configure')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('pipeline.configure')));

grant select on public.opportunities to authenticated;
grant insert (workspace_id, contact_id, pipeline_id, stage_id, title, value_cents, currency, assigned_user_id)
  on public.opportunities to authenticated;
grant update (stage_id, title, value_cents, currency, assigned_user_id) on public.opportunities to authenticated;
create policy opportunities_select on public.opportunities for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('pipeline.read'))
         and (deleted_at is null or (select private.has_permission('opportunities.delete'))));
create policy opportunities_insert on public.opportunities for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('opportunities.write'))
              and created_by = (select auth.uid()));
create policy opportunities_update on public.opportunities for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('opportunities.write'))
         and deleted_at is null)
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('opportunities.write')));

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------
grant select on public.calendars to authenticated;
grant insert (workspace_id, name, slug, timezone, duration_minutes, is_primary, active) on public.calendars to authenticated;
grant update (name, slug, timezone, duration_minutes, is_primary, active) on public.calendars to authenticated;
create policy calendars_select on public.calendars for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.read')));
create policy calendars_insert on public.calendars for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('calendar.configure')));
create policy calendars_update on public.calendars for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.configure')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('calendar.configure')));

grant select, insert, delete on public.calendar_members to authenticated;
create policy calendar_members_select on public.calendar_members for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.read')));
create policy calendar_members_insert on public.calendar_members for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('calendar.configure')));
create policy calendar_members_delete on public.calendar_members for delete to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.configure')));

grant select, delete on public.availability_rules to authenticated;
grant insert (workspace_id, calendar_id, weekday, start_time, end_time) on public.availability_rules to authenticated;
grant update (weekday, start_time, end_time) on public.availability_rules to authenticated;
create policy availability_rules_select on public.availability_rules for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.read')));
create policy availability_rules_insert on public.availability_rules for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('calendar.configure')));
create policy availability_rules_update on public.availability_rules for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.configure')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('calendar.configure')));
create policy availability_rules_delete on public.availability_rules for delete to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.configure')));

grant select on public.appointments to authenticated;
grant insert (workspace_id, calendar_id, contact_id, opportunity_id, assigned_user_id, starts_at, ends_at, status, notes)
  on public.appointments to authenticated;
grant update (calendar_id, opportunity_id, assigned_user_id, starts_at, ends_at, status, notes)
  on public.appointments to authenticated;
create policy appointments_select on public.appointments for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('calendar.read'))
         and deleted_at is null);
create policy appointments_insert on public.appointments for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('appointments.write'))
              and created_by = (select auth.uid()));
create policy appointments_update on public.appointments for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('appointments.write'))
         and deleted_at is null)
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('appointments.write')));

-- ---------------------------------------------------------------------------
-- Engagement
-- ---------------------------------------------------------------------------
grant select on public.conversations to authenticated;
grant insert (workspace_id, contact_id, channel, status, assigned_user_id) on public.conversations to authenticated;
grant update (status, assigned_user_id) on public.conversations to authenticated;
create policy conversations_select on public.conversations for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('conversations.read')));
create policy conversations_insert on public.conversations for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('conversations.write')));
create policy conversations_update on public.conversations for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('conversations.write')))
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('conversations.write')));

-- Users may only write internal notes; nothing is ever marked as sent.
grant select on public.messages to authenticated;
grant insert (workspace_id, conversation_id, direction, body) on public.messages to authenticated;
create policy messages_select on public.messages for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('conversations.read')));
create policy messages_insert_internal on public.messages for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('conversations.write'))
              and direction = 'internal'
              and delivery_status = 'not_sent'
              and author_user_id = (select auth.uid()));

grant select on public.tasks to authenticated;
grant insert (workspace_id, title, description, due_at, status, contact_id, opportunity_id, assigned_user_id)
  on public.tasks to authenticated;
grant update (title, description, due_at, status, contact_id, opportunity_id, assigned_user_id)
  on public.tasks to authenticated;
create policy tasks_select on public.tasks for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('tasks.read'))
         and deleted_at is null);
create policy tasks_insert on public.tasks for insert to authenticated
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('tasks.write'))
              and created_by = (select auth.uid()));
create policy tasks_update on public.tasks for update to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('tasks.write'))
         and deleted_at is null)
  with check (workspace_id = (select private.active_workspace_id())
              and (select private.has_permission('tasks.write')));

grant select on public.reviews to authenticated;
create policy reviews_select on public.reviews for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('reviews.read')));

grant select on public.activity_events to authenticated;
create policy activity_events_select on public.activity_events for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('dashboard.read')));

grant select on public.workspace_audit_log to authenticated;
create policy workspace_audit_log_select on public.workspace_audit_log for select to authenticated
  using (workspace_id = (select private.active_workspace_id())
         and (select private.has_permission('audit.read')));

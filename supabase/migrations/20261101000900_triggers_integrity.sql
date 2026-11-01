-- M9: integrity triggers.

-- ---------------------------------------------------------------------------
-- workspace_id immutability on every tenant table
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'workspace_members', 'member_permission_overrides', 'workspace_invitations',
    'platform_access_grants', 'workspace_settings', 'ai_receptionist_configs', 'integrations',
    'integration_secrets', 'contacts', 'contact_tags', 'contact_notes', 'pipelines',
    'pipeline_stages', 'opportunities', 'calendars', 'calendar_members', 'availability_rules',
    'appointments', 'conversations', 'messages', 'tasks', 'reviews', 'activity_events',
    'workspace_audit_log'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.forbid_workspace_change()',
      t || '_workspace_immutable', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff references must point at active members of the same workspace
-- (the composite FK already guarantees same-workspace; this adds "active").
-- ---------------------------------------------------------------------------
create trigger contacts_active_owner before insert or update on public.contacts
  for each row execute function private.assert_active_member('owner_user_id');
create trigger opportunities_active_assignee before insert or update on public.opportunities
  for each row execute function private.assert_active_member('assigned_user_id');
create trigger calendar_members_active_user before insert or update on public.calendar_members
  for each row execute function private.assert_active_member('user_id');
create trigger appointments_active_assignee before insert or update on public.appointments
  for each row execute function private.assert_active_member('assigned_user_id');
create trigger conversations_active_assignee before insert or update on public.conversations
  for each row execute function private.assert_active_member('assigned_user_id');
create trigger tasks_active_assignee before insert or update on public.tasks
  for each row execute function private.assert_active_member('assigned_user_id');
create trigger ai_receptionist_active_escalation before insert or update on public.ai_receptionist_configs
  for each row execute function private.assert_active_member('escalation_user_id');

-- ---------------------------------------------------------------------------
-- Actor attribution is database-controlled. For user requests (auth.uid() set) the column is
-- overwritten with the caller's identity; clients also hold no grant on these columns.
-- Requests without a JWT subject (service role, migrations) keep the supplied value.
-- ---------------------------------------------------------------------------

-- Usage: private.stamp_creator('created_by'). Set on insert, immutable afterwards.
create function private.stamp_creator()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_col text := tg_argv[0];
begin
  if tg_op = 'INSERT' then
    if v_uid is not null then
      new := jsonb_populate_record(new, jsonb_build_object(v_col, v_uid));
    end if;
  else
    new := jsonb_populate_record(new, jsonb_build_object(v_col, to_jsonb(old) -> v_col));
  end if;
  return new;
end;
$$;

-- Usage: private.stamp_updater('updated_by'). Set on every user write.
create function private.stamp_updater()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], v_uid));
  end if;
  return new;
end;
$$;

do $$
declare
  r record;
begin
  for r in select * from (values
    ('contacts', 'created_by'), ('opportunities', 'created_by'), ('appointments', 'created_by'),
    ('tasks', 'created_by'), ('integrations', 'connected_by')
  ) as v(tbl, col) loop
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function private.stamp_creator(%L)',
      r.tbl || '_stamp_' || r.col, r.tbl, r.col);
  end loop;
  for r in select * from (values
    ('workspace_settings', 'updated_by'), ('ai_receptionist_configs', 'updated_by')
  ) as v(tbl, col) loop
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function private.stamp_updater(%L)',
      r.tbl || '_stamp_' || r.col, r.tbl, r.col);
  end loop;
end;
$$;

-- Notes and messages: the author is the caller. An active member authors as themselves; a
-- platform admin may author only under a live write grant, which is recorded in author_grant_id.
-- Usage: private.stamp_author('author_id').
create function private.stamp_author()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_col text := tg_argv[0];
  v_grant uuid;
begin
  if tg_op = 'UPDATE' then
    new := jsonb_populate_record(new, jsonb_build_object(
      v_col, to_jsonb(old) -> v_col, 'author_grant_id', old.author_grant_id));
    return new;
  end if;
  if v_uid is null then
    return new;
  end if;

  if exists (
    select 1 from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id
    where m.workspace_id = new.workspace_id and m.user_id = v_uid
      and m.status = 'active' and w.status = 'active'
  ) then
    v_grant := null;
  elsif private.active_grant_mode(new.workspace_id) = 'write' then
    v_grant := private.active_grant_id(new.workspace_id);
  else
    raise exception '% must be an active member or hold a write grant for the workspace', v_col
      using errcode = '42501';
  end if;

  new := jsonb_populate_record(new, jsonb_build_object(v_col, v_uid, 'author_grant_id', v_grant));
  return new;
end;
$$;

create trigger contact_notes_stamp_author before insert or update on public.contact_notes
  for each row execute function private.stamp_author('author_id');
create trigger messages_stamp_author before insert or update on public.messages
  for each row execute function private.stamp_author('author_user_id');

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'workspace_settings', 'ai_receptionist_configs', 'integrations',
    'contacts', 'opportunities', 'appointments', 'tasks'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
      t || '_updated_at', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Append-only logs
-- ---------------------------------------------------------------------------
create trigger activity_events_append_only before update or delete on public.activity_events
  for each row execute function private.reject_mutation();
create trigger workspace_audit_log_append_only before update or delete on public.workspace_audit_log
  for each row execute function private.reject_mutation();
create trigger platform_audit_log_append_only before update or delete on public.platform_audit_log
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------------------------
-- Owner-affecting membership changes serialize on the workspace row. Every RPC that can change
-- owners calls this before reading or mutating membership; guard_last_owner calls it too so
-- direct (service-role) writes also serialize. NO KEY UPDATE does not block FK inserts.
-- ---------------------------------------------------------------------------
create function private.lock_workspace_membership(p_workspace_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.workspaces w where w.id = p_workspace_id for no key update;
end;
$$;

-- ---------------------------------------------------------------------------
-- A non-archived workspace that has members must keep at least one active owner.
-- ---------------------------------------------------------------------------
create function private.guard_last_owner()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active') then
    perform private.lock_workspace_membership(old.workspace_id);
    if not exists (
         select 1 from public.workspace_members m
         where m.workspace_id = old.workspace_id
           and m.role = 'owner' and m.status = 'active'
           and m.user_id <> old.user_id)
       and exists (
         select 1 from public.workspaces w
         where w.id = old.workspace_id and w.status <> 'archived') then
      raise exception 'a workspace must keep at least one active owner' using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger workspace_members_last_owner after update or delete on public.workspace_members
  for each row execute function private.guard_last_owner();

-- Records the first time a workspace has an active owner (closes bootstrap rotation for good).
create function private.mark_owner_acquired()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.role = 'owner' and new.status = 'active' then
    update public.workspaces set owner_acquired_at = now()
      where id = new.workspace_id and owner_acquired_at is null;
  end if;
  return null;
end;
$$;

create trigger workspace_members_owner_acquired after insert or update on public.workspace_members
  for each row execute function private.mark_owner_acquired();

-- ---------------------------------------------------------------------------
-- Permission overrides apply to employees only.
-- ---------------------------------------------------------------------------
create function private.overrides_employee_only()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = new.workspace_id and m.user_id = new.user_id
      and m.role = 'employee' and m.status = 'active'
  ) then
    raise exception 'permission overrides apply to active employees only' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger member_permission_overrides_employee_only
  before insert or update on public.member_permission_overrides
  for each row execute function private.overrides_employee_only();

-- ---------------------------------------------------------------------------
-- Pipelines hold exactly 12 stages; stage structure is fixed after creation.
-- ---------------------------------------------------------------------------
create function private.check_stage_count()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_pipeline uuid;
  v_count int;
begin
  if tg_table_name = 'pipelines' then
    v_pipeline := new.id;
  elsif tg_op = 'DELETE' then
    v_pipeline := old.pipeline_id;
  else
    v_pipeline := new.pipeline_id;
  end if;

  if not exists (select 1 from public.pipelines p where p.id = v_pipeline) then
    return null;
  end if;

  select count(*) into v_count from public.pipeline_stages s where s.pipeline_id = v_pipeline;
  if v_count <> 12 then
    raise exception 'pipeline % must have exactly 12 stages (has %)', v_pipeline, v_count
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger pipelines_twelve_stages
  after insert on public.pipelines
  deferrable initially deferred
  for each row execute function private.check_stage_count();

create constraint trigger pipeline_stages_twelve_stages
  after insert or delete on public.pipeline_stages
  deferrable initially deferred
  for each row execute function private.check_stage_count();

create function private.freeze_stage_structure()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.pipeline_id is distinct from old.pipeline_id
     or new.position is distinct from old.position
     or new.kind is distinct from old.kind then
    raise exception 'stage pipeline, position, and kind are fixed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger pipeline_stages_frozen before update on public.pipeline_stages
  for each row execute function private.freeze_stage_structure();

-- ---------------------------------------------------------------------------
-- Opportunity status follows its stage kind.
-- ---------------------------------------------------------------------------
create function private.sync_opportunity_status()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text;
begin
  select s.kind into v_kind
  from public.pipeline_stages s
  where s.id = new.stage_id and s.workspace_id = new.workspace_id;

  new.status := case v_kind when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
  if new.status in ('won', 'lost') then
    new.closed_at := coalesce(case when tg_op = 'UPDATE' and old.stage_id = new.stage_id then old.closed_at end, now());
  else
    new.closed_at := null;
  end if;
  return new;
end;
$$;

create trigger opportunities_status_from_stage before insert or update on public.opportunities
  for each row execute function private.sync_opportunity_status();

-- ---------------------------------------------------------------------------
-- Integration verification state is server-controlled. Client writes (auth.uid() set) can never
-- leave an integration connected or verified: inserts start disconnected, and any client change
-- to config clears verification. Trusted verification runs without a JWT subject (service role).
-- AI receptionist enablement is blocked by a check constraint (ai_receptionist_disabled_until_runtime).
-- ---------------------------------------------------------------------------
create function private.guard_integration_verification()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' or new.config is distinct from old.config then
    new.status := 'disconnected';
    new.capabilities := '{}';
    new.verified_at := null;
  else
    new.status := old.status;
    new.capabilities := old.capabilities;
    new.verified_at := old.verified_at;
  end if;
  return new;
end;
$$;

create trigger integrations_guard_verification before insert or update on public.integrations
  for each row execute function private.guard_integration_verification();

-- ---------------------------------------------------------------------------
-- Profile row for every new auth user.
-- ---------------------------------------------------------------------------
create function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, coalesce(left(new.raw_user_meta_data ->> 'full_name', 120), ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_profile after insert on auth.users
  for each row execute function private.handle_new_user();

revoke all on all functions in schema private from public, anon;

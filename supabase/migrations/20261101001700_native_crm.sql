-- M18 (P5): atomic native record saves (contact + tags, calendar + members, availability) that run
-- with the caller's own privileges, and activity events for record changes made with a user JWT.
-- Additive only.

-- ---------------------------------------------------------------------------
-- Atomic saves (security invoker: RLS, column grants, and integrity triggers apply as for direct
-- PostgREST writes; each call is one transaction)
-- ---------------------------------------------------------------------------

-- Creates (p_id null) or updates a contact from the keys present in p_values, and replaces its tags
-- when p_tags is not null.
create function public.save_contact(p_id uuid, p_values jsonb, p_tags text[] default null)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_ws uuid := private.active_workspace_id();
  v_id uuid;
begin
  if v_ws is null or not private.has_permission('contacts.write') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' or exists (
       select 1 from jsonb_object_keys(p_values) k
       where k not in ('first_name', 'last_name', 'email', 'phone', 'source', 'owner_user_id', 'dnd'))
     or (p_tags is not null and cardinality(p_tags) > 20) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.contacts (workspace_id, first_name, last_name, email, phone, source, owner_user_id, dnd)
    values (v_ws,
            coalesce(p_values ->> 'first_name', ''),
            coalesce(p_values ->> 'last_name', ''),
            p_values ->> 'email',
            p_values ->> 'phone',
            coalesce(p_values ->> 'source', 'manual'),
            (p_values ->> 'owner_user_id')::uuid,
            coalesce((p_values ->> 'dnd')::boolean, false))
    returning id into v_id;
  else
    update public.contacts c set
      first_name    = case when p_values ? 'first_name' then coalesce(p_values ->> 'first_name', '') else c.first_name end,
      last_name     = case when p_values ? 'last_name' then coalesce(p_values ->> 'last_name', '') else c.last_name end,
      email         = case when p_values ? 'email' then p_values ->> 'email' else c.email end,
      phone         = case when p_values ? 'phone' then p_values ->> 'phone' else c.phone end,
      source        = case when p_values ? 'source' then coalesce(p_values ->> 'source', 'manual') else c.source end,
      owner_user_id = case when p_values ? 'owner_user_id' then (p_values ->> 'owner_user_id')::uuid else c.owner_user_id end,
      dnd           = case when p_values ? 'dnd' then coalesce((p_values ->> 'dnd')::boolean, false) else c.dnd end
    where c.id = p_id and c.workspace_id = v_ws and c.deleted_at is null
    returning c.id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  if p_tags is not null then
    delete from public.contact_tags t where t.workspace_id = v_ws and t.contact_id = v_id;
    insert into public.contact_tags (workspace_id, contact_id, tag)
    select v_ws, v_id, x from unnest(p_tags) x;
  end if;
  return v_id;
end;
$$;

-- Creates (p_id null) or updates a calendar, and sets its members to p_member_ids when not null.
-- Members must be active members of the workspace (calendar_members_active_user trigger).
create function public.save_calendar(p_id uuid, p_values jsonb, p_member_ids uuid[] default null)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_ws uuid := private.active_workspace_id();
  v_id uuid;
begin
  if v_ws is null or not private.has_permission('calendar.configure') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'object' or exists (
       select 1 from jsonb_object_keys(p_values) k
       where k not in ('name', 'slug', 'timezone', 'duration_minutes', 'active'))
     or (p_member_ids is not null and cardinality(p_member_ids) > 100) then
    raise exception 'validation_failed' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.calendars (workspace_id, name, slug, timezone, duration_minutes, active)
    values (v_ws,
            p_values ->> 'name',
            p_values ->> 'slug',
            coalesce(p_values ->> 'timezone', 'America/New_York'),
            (p_values ->> 'duration_minutes')::smallint,
            coalesce((p_values ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update public.calendars c set
      name             = case when p_values ? 'name' then p_values ->> 'name' else c.name end,
      slug             = case when p_values ? 'slug' then p_values ->> 'slug' else c.slug end,
      timezone         = case when p_values ? 'timezone' then p_values ->> 'timezone' else c.timezone end,
      duration_minutes = case when p_values ? 'duration_minutes' then (p_values ->> 'duration_minutes')::smallint else c.duration_minutes end,
      active           = case when p_values ? 'active' then (p_values ->> 'active')::boolean else c.active end
    where c.id = p_id and c.workspace_id = v_ws
    returning c.id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;

  if p_member_ids is not null then
    delete from public.calendar_members m
      where m.workspace_id = v_ws and m.calendar_id = v_id and not (m.user_id = any (p_member_ids));
    insert into public.calendar_members (workspace_id, calendar_id, user_id)
    select distinct v_ws, v_id, u from unnest(p_member_ids) u
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

-- Replaces a calendar's weekly availability: [{ weekday 0-6, start 'HH:MM', end 'HH:MM' }, ...].
create function public.replace_availability(p_calendar_id uuid, p_rules jsonb)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_ws uuid := private.active_workspace_id();
begin
  if v_ws is null or not private.has_permission('calendar.configure') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 50 or exists (
       select 1 from jsonb_array_elements(p_rules) e
       where jsonb_typeof(e) <> 'object'
          or coalesce(e ->> 'weekday', '') !~ '^[0-6]$'
          or coalesce(e ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
          or coalesce(e ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
    raise exception 'validation_failed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.calendars c where c.id = p_calendar_id and c.workspace_id = v_ws) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.availability_rules r where r.workspace_id = v_ws and r.calendar_id = p_calendar_id;
  insert into public.availability_rules (workspace_id, calendar_id, weekday, start_time, end_time)
  select v_ws, p_calendar_id, (e ->> 'weekday')::smallint, (e ->> 'start')::time, (e ->> 'end')::time
  from jsonb_array_elements(p_rules) e;
end;
$$;

-- ---------------------------------------------------------------------------
-- Activity events for record changes made with a user JWT. Payloads name changed fields (and stage
-- ids for moves), never values. Trusted server writes without a JWT subject are not recorded.
-- Usage: private.record_crm_activity('<entity type>').
-- ---------------------------------------------------------------------------
create function private.record_crm_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_ws uuid := (v_new ->> 'workspace_id')::uuid;
  v_entity_id uuid := (v_new ->> 'id')::uuid;
  v_action text;
  v_fields text[];
  v_payload jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;

  if tg_table_name = 'contact_notes' then
    v_entity_id := (v_new ->> 'contact_id')::uuid;
    v_action := 'note_added';
  elsif tg_table_name = 'messages' then
    v_entity_id := (v_new ->> 'conversation_id')::uuid;
    v_action := 'note_added';
  elsif tg_op = 'INSERT' then
    v_action := 'created';
  else
    select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
    from jsonb_each(v_new) n
    where n.key not in ('updated_at', 'updated_by') and n.value is distinct from (v_old -> n.key);
    if cardinality(v_fields) = 0 then
      return null;
    end if;
    if v_new ->> 'deleted_at' is not null and v_old ->> 'deleted_at' is null then
      v_action := 'deleted';
    elsif tg_argv[0] = 'opportunity' and v_new ->> 'status' is distinct from v_old ->> 'status'
          and v_new ->> 'status' in ('won', 'lost') then
      v_action := v_new ->> 'status';
    elsif tg_argv[0] = 'opportunity' and v_new ->> 'stage_id' is distinct from v_old ->> 'stage_id' then
      v_action := 'stage_changed';
    elsif tg_argv[0] = 'appointment' and v_new ->> 'status' is distinct from v_old ->> 'status'
          and v_new ->> 'status' in ('cancelled', 'no_show', 'completed') then
      v_action := v_new ->> 'status';
    elsif tg_argv[0] = 'appointment' and (v_new ->> 'starts_at' is distinct from v_old ->> 'starts_at'
          or v_new ->> 'ends_at' is distinct from v_old ->> 'ends_at') then
      v_action := 'rescheduled';
    elsif tg_argv[0] = 'task' and v_new ->> 'status' = 'done' and v_old ->> 'status' <> 'done' then
      v_action := 'completed';
    else
      v_action := 'updated';
    end if;
    v_payload := jsonb_build_object('fields', to_jsonb(v_fields));
    if tg_argv[0] = 'opportunity' and v_new ->> 'stage_id' is distinct from v_old ->> 'stage_id' then
      v_payload := v_payload || jsonb_build_object('from_stage_id', v_old -> 'stage_id', 'to_stage_id', v_new -> 'stage_id');
    end if;
  end if;

  insert into public.activity_events (workspace_id, entity_type, entity_id, action, actor_id, actor_kind, payload)
  values (v_ws, tg_argv[0], v_entity_id, v_action, auth.uid(),
          case when private.active_member_role(v_ws) is not null then 'member' else 'platform_admin' end,
          v_payload);
  return null;
end;
$$;

create trigger contacts_record_activity after insert or update on public.contacts
  for each row execute function private.record_crm_activity('contact');
create trigger contact_notes_record_activity after insert on public.contact_notes
  for each row execute function private.record_crm_activity('contact');
create trigger opportunities_record_activity after insert or update on public.opportunities
  for each row execute function private.record_crm_activity('opportunity');
create trigger calendars_record_activity after insert or update on public.calendars
  for each row execute function private.record_crm_activity('calendar');
create trigger appointments_record_activity after insert or update on public.appointments
  for each row execute function private.record_crm_activity('appointment');
create trigger tasks_record_activity after insert or update on public.tasks
  for each row execute function private.record_crm_activity('task');
create trigger messages_record_activity after insert on public.messages
  for each row execute function private.record_crm_activity('conversation');

revoke all on function private.record_crm_activity() from public, anon, authenticated;

revoke all on function
  public.save_contact(uuid, jsonb, text[]),
  public.save_calendar(uuid, jsonb, uuid[]),
  public.replace_availability(uuid, jsonb)
from public, anon, authenticated;

grant execute on function
  public.save_contact(uuid, jsonb, text[]),
  public.save_calendar(uuid, jsonb, uuid[]),
  public.replace_availability(uuid, jsonb)
to authenticated;

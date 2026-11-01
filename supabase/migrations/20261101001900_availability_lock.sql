-- M20: replace_availability (M18) serializes per calendar.
-- Without a lock, two concurrent replacements of the same calendar's weekly hours could both delete
-- the old rules and both insert theirs, leaving a merge of the two submissions. The calendar row is
-- now locked first (FOR UPDATE needs calendar.configure through calendars_update, the same permission
-- the function already requires), so a second replacement waits, then deletes the first one's rules
-- with a fresh snapshot and inserts its own: the final schedule is exactly one complete submission.
-- Signature, grants, and validation are unchanged (create or replace keeps the existing grants).

create or replace function public.replace_availability(p_calendar_id uuid, p_rules jsonb)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_ws uuid := private.active_workspace_id();
  v_locked uuid;
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
  select c.id into v_locked from public.calendars c
  where c.id = p_calendar_id and c.workspace_id = v_ws
  for update;
  if v_locked is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.availability_rules r where r.workspace_id = v_ws and r.calendar_id = p_calendar_id;
  insert into public.availability_rules (workspace_id, calendar_id, weekday, start_time, end_time)
  select v_ws, p_calendar_id, (e ->> 'weekday')::smallint, (e ->> 'start')::time, (e ->> 'end')::time
  from jsonb_array_elements(p_rules) e;
end;
$$;

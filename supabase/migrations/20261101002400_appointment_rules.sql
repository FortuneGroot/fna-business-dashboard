-- M25: appointment rules enforced by the database, not only by the API.
--
-- The API refused new bookings on an inactive calendar but not reschedules or re-bookings, and it
-- checked the 24-hour limit against the row it had read, so two simultaneous edits (one moving the
-- start, one the end) could store a much longer appointment. Members can also update appointments
-- through the Data API directly. This trigger checks the row as it will be stored: a booking that
-- takes a slot (new, moved, or revived as booked/confirmed) must be on an active calendar, and new or
-- moved times may span at most 24 hours. Confirming, completing or cancelling an existing booking on
-- a deactivated calendar is still allowed.

create function private.appointment_rules()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_moved boolean := tg_op = 'INSERT' or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
                     or new.calendar_id <> old.calendar_id;
  v_takes_slot boolean;
begin
  if v_moved and new.ends_at - new.starts_at > interval '24 hours' then
    raise exception 'appointment_too_long' using errcode = '23514';
  end if;
  v_takes_slot := new.status in ('booked', 'confirmed') and new.deleted_at is null
    and (v_moved or old.status not in ('booked', 'confirmed') or old.deleted_at is not null);
  if v_takes_slot
     and not exists (select 1 from public.calendars c where c.id = new.calendar_id and c.active) then
    raise exception 'calendar_inactive' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.appointment_rules() from public, anon, authenticated;

create trigger appointments_rules
  before insert or update of calendar_id, starts_at, ends_at, status, deleted_at on public.appointments
  for each row execute function private.appointment_rules();

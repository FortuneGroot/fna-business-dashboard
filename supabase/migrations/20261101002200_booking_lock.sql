-- M23: simultaneous bookings of one calendar slot are serialized per calendar before the overlap
-- check. The exclusion constraint inserts first and checks afterwards, so two concurrent
-- conflicting inserts could each wait for the other and one was aborted as a deadlock (40P01,
-- answered as 503) instead of being refused as an overlap (23P01, answered as 409).
-- Every insert or update that leaves (or makes) a live booking takes a transaction-scoped
-- advisory lock per calendar involved, in a fixed order, so the second booking simply waits and
-- then sees the first.

create or replace function private.lock_appointment_calendars()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_id uuid;
begin
  if tg_op = 'UPDATE' then
    v_ids := array[new.calendar_id, old.calendar_id];
  else
    v_ids := array[new.calendar_id];
  end if;
  for v_id in select distinct u from unnest(v_ids) u where u is not null order by u loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fna.appointments:' || v_id::text, 0));
  end loop;
  return new;
end;
$$;

revoke all on function private.lock_appointment_calendars() from public, anon, authenticated;

create trigger appointments_lock_calendar
  before insert or update of calendar_id, starts_at, ends_at, status, deleted_at on public.appointments
  for each row execute function private.lock_appointment_calendars();

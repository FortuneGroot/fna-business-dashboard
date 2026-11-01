-- M14: lock down the legacy tables (auth_sessions, sync_*) without touching their data.
-- They are read and written only by the server with the service-role key. Supabase's default
-- privileges left them granted to anon/authenticated, and sync_* had RLS disabled, so they were
-- reachable through the public Data API. This revokes those grants, enables default-deny RLS
-- (no policies), and keeps explicit service_role access. Tables, rows, and columns are unchanged.
-- Missing tables are skipped so this applies cleanly to projects that never ran the legacy files.

do $$
declare
  t text;
begin
  foreach t in array array[
    'auth_sessions', 'sync_contacts', 'sync_contact_tags', 'sync_opportunities', 'sync_appointments',
    'sync_conversation_events', 'sync_tasks', 'sync_review_events', 'sync_events', 'sync_idempotency'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end;
$$;
